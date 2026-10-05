// Gathers project + beneficiary reference data (portfolio, targets, action plans, MIS,
// financials, compliance, vault/media lists, impact indicators, beneficiary stats) as
// text blocks for /api/get-ai-report's `supplementaryData`.
// Client-side because that logic lives inline in several route handlers; each fetch is
// try/caught since field workers get 403 on MIS/budget and those blocks are just skipped.

import { apiFetch } from './apiFetch'
import { jsonToReadableText } from './notebookSourceText'
import type { ActiveFilters } from '../types/report'

export interface SupplementaryBlock {
  label: string
  content: string
}

// GET /api/action-plans rows (ProjectContext.tsx's PortfolioProject).
interface PortfolioPlan {
  id: string
  project_key: string
  name: string
  year?: number | null
  donor?: string | null
  region?: string | null
  budget?: number | string | null
  end_date?: string | null
  locations?: unknown
  budgetUsed?: number
}

function locationName(l: unknown): string {
  if (typeof l === 'string') return l
  if (l && typeof l === 'object') {
    const o = l as Record<string, unknown>
    return String(o.name ?? o.location ?? o.district_name ?? o.village ?? '')
  }
  return ''
}

function portfolioRow(p: PortfolioPlan): Record<string, unknown> {
  const budget = Number(p.budget) || 0
  const locs = Array.isArray(p.locations) ? p.locations.map(locationName).filter(Boolean) : []
  return {
    'Project': p.name,
    'Donor': p.donor || '—',
    'Region': p.region || '—',
    'Year': p.year ?? '—',
    'End Date': p.end_date ? String(p.end_date).slice(0, 10) : '—',
    'Total Budget': budget > 0 ? '₹' + Math.round(budget).toLocaleString('en-IN') : '—',
    'Budget Utilised (%)': budget > 0 ? (p.budgetUsed ?? 0) : '—',
    'Locations': locs.length ? `${locs.length} — ${locs.slice(0, 15).join(', ')}${locs.length > 15 ? ', …' : ''}` : '—',
  }
}

// Metadata only (never file contents or uploader identities), newest first.
const MAX_LIST_ITEMS = 40

function pickList<T extends Record<string, unknown>>(resp: unknown, key: string, map: (r: T) => Record<string, unknown>): Record<string, unknown>[] | null {
  const rows = (resp as Record<string, unknown> | null)?.[key]
  return Array.isArray(rows) && rows.length ? (rows as T[]).slice(0, MAX_LIST_ITEMS).map(map) : null
}

const day = (v: unknown) => (v ? String(v).slice(0, 10) : '—')

// Caps keep the added prompt bounded so field activity records stay the bulk of it.
const MAX_PROJECTS      = 8      // most-relevant projects only (first N in scope)
const PER_BLOCK_CHARS   = 4_000  // per data block (jsonToReadableText cap)
const TOTAL_CHARS       = 50_000 // hard ceiling across all blocks combined (server caps at 60k)

const MIS_MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'] as const

/** Indian financial year (Apr–Mar) start year + short month name for the MIS
 *  dashboard, derived from the report period's end date (or today). */
function misPeriodFrom(filters: ActiveFilters): { fyStartYear: number; month: typeof MIS_MONTHS[number] } {
  const ref = filters?.dateTo || filters?.dateFrom || ''
  const d = ref ? new Date(ref) : new Date()
  const dd = isNaN(d.getTime()) ? new Date() : d
  const y = dd.getFullYear()
  const m = dd.getMonth() // 0=Jan
  const fyStartYear = m >= 3 ? y : y - 1
  const short = dd.toLocaleDateString('en-US', { month: 'short' }) as typeof MIS_MONTHS[number]
  const month = MIS_MONTHS.includes(short) ? short : 'Apr'
  return { fyStartYear, month }
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await apiFetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function hasData(data: unknown): boolean {
  if (data === null || data === undefined) return false
  if (typeof data === 'object' && data !== null && 'error' in (data as Record<string, unknown>)) return false
  if (Array.isArray(data)) return data.length > 0
  if (typeof data === 'object') return Object.keys(data as object).length > 0
  return true
}

/** `projectNames` empty means the whole org; `filters` only feeds the MIS FY/month. */
export async function gatherContentHubReferenceData(
  projectNames: string[],
  filters: ActiveFilters,
): Promise<SupplementaryBlock[]> {
  const blocks: SupplementaryBlock[] = []
  let used = 0

  const push = (label: string, data: unknown) => {
    if (used >= TOTAL_CHARS || !hasData(data)) return
    const remaining = TOTAL_CHARS - used
    const content = jsonToReadableText(label, data, Math.min(PER_BLOCK_CHARS, remaining))
    if (!content.trim()) return
    blocks.push({ label, content })
    used += content.length
  }

  // Resolve free-text project names to action_plans rows (a project IS an action_plans row).
  const plansResp = await getJson('/api/action-plans') as { plans?: PortfolioPlan[] } | null
  const allPlans = Array.isArray(plansResp?.plans) ? plansResp!.plans! : []
  if (allPlans.length === 0) return blocks

  const wanted = new Set(projectNames.map(n => n.trim().toLowerCase()).filter(Boolean))
  // Empty scope means every plan; otherwise case-insensitive name match.
  const scoped = wanted.size === 0
    ? allPlans
    : allPlans.filter(p => wanted.has((p.name || '').trim().toLowerCase()))
  const inScope = scoped.length > 0 ? scoped : allPlans
  const targetPlans = inScope.slice(0, MAX_PROJECTS)
  const singleProject = wanted.size > 0 && inScope.length === 1 ? inScope[0] : null

  const { fyStartYear, month } = misPeriodFrom(filters)
  const misParams = new URLSearchParams({ fy_start_year: String(fyStartYear), month }).toString()
  const periodLabel = `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}, ${month}`

  // Fetched in parallel, pushed in fixed priority order so TOTAL_CHARS drops the least
  // important blocks first, never the portfolio / org-wide summaries.
  const impactUrl = singleProject
    ? `/api/impact/framework?projectKey=${encodeURIComponent(singleProject.project_key)}`
    : '/api/impact/framework'
  const [impact, benef, ibList, meList, cbList, perProject] = await Promise.all([
    getJson(impactUrl),
    getJson('/api/beneficiary-registration-dashboard'),
    // Only the aggregate `kpis` are kept; per-beneficiary rows (PII) are discarded.
    getJson('/api/individual-beneficiaries'),
    getJson('/api/micro-entrepreneurs'),
    getJson('/api/collectives'),
    Promise.all(targetPlans.map(async (plan) => {
      const key = encodeURIComponent(plan.project_key)
      const [misDash, misTabs, target, financial, plan_, compliance, docs, media] = await Promise.all([
        getJson(`/api/projects/${key}/mis-dashboard?${misParams}`),
        getJson(`/api/projects/${key}/mis-tabs-dashboard`),
        getJson(`/api/action-plans/${plan.id}/annual-progress/latest`),
        getJson(`/api/action-plans/${plan.id}/budget-utilisation`),
        getJson(`/api/action-plans/${plan.id}`),
        getJson(`/api/compliance-items?project=${key}`),
        getJson(`/api/projects/${key}/documents`),
        getJson(`/api/projects/${key}/media`),
      ])
      return { plan, misDash, misTabs, target, financial, plan_, compliance, docs, media }
    })),
  ])

  // 1. Portfolio: one compact row per project, covering beyond MAX_PROJECTS.
  push(
    wanted.size === 0 ? 'PROJECT PORTFOLIO — All active projects' : 'PROJECT PORTFOLIO — Projects in this report',
    inScope.map(portfolioRow),
  )

  // 2. Org-wide / scope-wide summaries.
  push(`IMPACT FRAMEWORK INDICATORS — ${singleProject ? singleProject.name : 'Organisation-wide'}`, impact)
  push('BENEFICIARY STATISTICS — Organisation-wide', benef)
  const kpisOf = (r: unknown) => (r as Record<string, unknown> | null)?.kpis ?? null
  const profileKpis: Record<string, unknown> = {}
  if (kpisOf(ibList)) profileKpis['Individual Beneficiaries'] = kpisOf(ibList)
  if (kpisOf(meList)) profileKpis['Micro-Entrepreneurs'] = kpisOf(meList)
  if (kpisOf(cbList)) profileKpis['Collectives'] = kpisOf(cbList)
  push('BENEFICIARY PROFILE SUMMARY — Organisation-wide (aggregate counts only)', profileKpis)

  // 3. Per-project detail, in scope order.
  for (const r of perProject) {
    const n = r.plan.name
    push(`ANNUAL TARGETS & PROGRESS — ${n}`, r.target)
    push(`BUDGET & FINANCIAL UTILISATION — ${n}`, r.financial)
    push(`MIS INDICATORS — ${n} (${periodLabel})`, r.misDash)
    push(`MIS CATEGORY SUMMARY — ${n}`, r.misTabs)
    push(`COMPLIANCE CALENDAR — ${n}`, pickList(r.compliance, 'items', (c) => ({
      'Item': c.item, 'Due': c.dueLabel || day(c.due), 'Status': c.status,
    })))
    push(`DOCUMENT VAULT (file list only) — ${n}`, pickList(r.docs, 'documents', (d) => ({
      'Document': d.name, 'Section': d.vault_tab, 'Category': d.report_category || '—', 'Uploaded': day(d.created_at),
    })))
    push(`PROJECT MEDIA (file list only) — ${n}`, pickList(r.media, 'media', (m) => ({
      'File': m.name, 'Type': m.media_type, 'Category': m.category || '—', 'Uploaded': day(m.created_at),
    })))
    push(`ACTION PLAN — ${n}`, r.plan_)
  }

  return blocks
}
