// Beneficiary Profile tab: rosters for the three registered categories (Indirect
// Beneficiary is an MIS by-product, so it has no tab). Each row opens the full
// record plus its linked MIS records via GET /api/beneficiary-profile/:uid.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X, User, Search, QrCode, Download, Printer, PlusCircle, FileSpreadsheet, Pencil } from 'lucide-react'
import { saveAs } from 'file-saver'
import { apiFetch } from '../../utils/apiFetch'
import { authedDownload } from '../../utils/authedDownload'
import { useOrg } from '../../context/OrgContext'
import { useAuthContext } from '../../context/AuthContext'
import { FF, projectDot, projectBadge } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { TabPill } from '../ui/TabPill'
import { AddInterventionModal, INTERVENTION_CATEGORIES, type InterventionCategoryConfig } from './AddInterventionModal'
import { BeneficiaryRegistrationDashboardPage } from './BeneficiaryRegistrationDashboardPage'
import type {
  BeneficiaryProfileResponse, TrainingRow, IncomeRow, InputDistributionRow, SchemeAccessRow,
  CreditGrantAccessRow, BusinessDevelopmentSupportRow, ComplianceSupportRow, ExposureVisitRow,
  ResourceRow, LinkedProject,
} from '../../types/beneficiaryProfile'

type CategoryKey = 'individual' | 'entrepreneur' | 'collective'

interface RosterRow {
  id: string
  uid: string
  displayName: string
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  village: string | null
  [key: string]: unknown
}
interface RosterData {
  rows: RosterRow[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Record<string, number>
  states: string[]
  districts: string[]
  blocks: string[]
  villages: string[]
}
const EMPTY_ROSTER: RosterData = { rows: [], totalRows: 0, page: 0, pageSize: 50, kpis: { total: 0 }, states: [], districts: [], blocks: [], villages: [] }

// One label:value row on the printable ID card (BeneficiaryIdCard below).
interface CardField {
  label: string
  of: (raw: any) => unknown
}

interface CategoryConfig {
  key: CategoryKey
  label: string
  endpoint: string
  searchPlaceholder: string
  nameOf: (raw: any) => string
  subLabelOf: (raw: any) => string // one distinguishing extra field shown under the name
  kpiTiles: { label: string; value: (kpis: Record<string, number>) => string | number; note?: (kpis: Record<string, number>) => string }[]
  // ID card fields, top to bottom. The roster row already carries them (and the
  // profile record is a superset), so the card needs no extra fetch.
  cardFields: CardField[]
}

function inr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

// production_systems as one string (Livestock is a headcount, the rest are in
// Quintal). Older registrations only have the single production_type field.
function productionSystemsSummary(r: any): string {
  if (Array.isArray(r.production_systems) && r.production_systems.length) {
    return r.production_systems
      .map((p: any) => `${p.type}: ${p.type === 'Livestock' ? (p.livestock_count ?? '—') : (p.production_quintal != null ? `${p.production_quintal} qtl` : '—')}`)
      .join(', ')
  }
  return r.production_type || ''
}

const pctOf = (part: number | undefined, whole: number | undefined) =>
  whole ? `${Math.round(((part ?? 0) / whole) * 100)}%` : ''
const qtl = (n: number | undefined) => `${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} qtl`

// Counts come from each list endpoint's kpis (lib/productionSystemsSql.js);
// the note is Quintal produced, or a livestock headcount.
const PRODUCTION_TILES: { label: string; countKey: string; note: (k: Record<string, number>) => string }[] = [
  { label: 'Aquaculture',  countKey: 'aquaculture',  note: k => qtl(k.aquacultureQtl) },
  { label: 'Agriculture',  countKey: 'agriculture',  note: k => qtl(k.agricultureQtl) },
  { label: 'Livestock',    countKey: 'livestock',    note: k => `${(k.totalLivestock ?? 0).toLocaleString('en-IN')} livestock` },
  { label: 'Horticulture', countKey: 'horticulture', note: k => qtl(k.horticultureQtl) },
]

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'individual', label: 'Individual Beneficiary', endpoint: '/api/individual-beneficiaries',
    searchPlaceholder: 'Search UID, name, mobile or village…',
    nameOf: r => r.name, subLabelOf: r => productionSystemsSummary(r) || r.occupation || '—',
    kpiTiles: [
      { label: 'Total Beneficiaries', value: k => k.total ?? 0 },
      { label: 'Male', value: k => k.male ?? 0, note: k => pctOf(k.male, k.total) },
      { label: 'Female', value: k => k.female ?? 0, note: k => pctOf(k.female, k.total) },
      { label: 'Collective Members', value: k => k.collectiveMembers ?? 0, note: k => pctOf(k.collectiveMembers, k.total) },
      { label: 'Avg. Income', value: k => inr(k.avgIncome) },
      { label: 'Total Production', value: k => qtl(k.totalProduction) },
    ],
    cardFields: [
      { label: 'Name',      of: r => r.name },
      { label: 'Mobile',    of: r => r.contact_no },
      { label: 'Gender',    of: r => r.gender },
      { label: 'Occupation',of: r => r.occupation || productionSystemsSummary(r) },
      { label: 'State',     of: r => r.state },
      { label: 'District',  of: r => r.district },
      { label: 'Block',     of: r => r.block },
      { label: 'Panchayat', of: r => r.panchayat },
      { label: 'Village',   of: r => r.village },
    ],
  },
  {
    key: 'entrepreneur', label: 'Micro-Entrepreneur', endpoint: '/api/micro-entrepreneurs',
    searchPlaceholder: 'Search UID, name, mobile, village or enterprise…',
    nameOf: r => r.name, subLabelOf: r => r.enterprise_name || r.business_activity || '—',
    kpiTiles: [
      { label: 'Total Entrepreneurs', value: k => k.total ?? 0 },
      { label: 'Male', value: k => k.male ?? 0, note: k => pctOf(k.male, k.total) },
      { label: 'Female', value: k => k.female ?? 0, note: k => pctOf(k.female, k.total) },
      { label: 'Avg. Revenue', value: k => inr(k.avgRevenue), note: k => `Total ${inr(k.totalRevenue)}` },
      { label: 'Total Employees', value: k => k.totalEmployees ?? 0 },
      { label: 'Total Production', value: k => qtl(k.totalProduction) },
    ],
    cardFields: [
      { label: 'Name',       of: r => r.name },
      { label: 'Mobile',     of: r => r.contact_no },
      { label: 'Gender',     of: r => r.gender },
      { label: 'Enterprise', of: r => r.enterprise_name || r.business_activity },
      { label: 'State',      of: r => r.state },
      { label: 'District',   of: r => r.district },
      { label: 'Block',      of: r => r.block },
      { label: 'Panchayat',  of: r => r.panchayat },
      { label: 'Village',    of: r => r.village },
    ],
  },
  {
    key: 'collective', label: 'Collective', endpoint: '/api/collectives',
    searchPlaceholder: 'Search UID, name, lead person, mobile or village…',
    nameOf: r => r.collective_name, subLabelOf: r => r.collective_type || r.focus_area || '—',
    kpiTiles: [
      { label: 'Total Collectives', value: k => k.total ?? 0 },
      { label: 'Total Members', value: k => (k.totalMale ?? 0) + (k.totalFemale ?? 0), note: k => `${k.totalMale ?? 0} Male · ${k.totalFemale ?? 0} Female` },
      { label: 'Avg. Revenue', value: k => inr(k.avgRevenue), note: k => `Total ${inr(k.totalRevenue)}` },
      { label: 'Total Credit Access', value: k => inr(k.totalCreditAccess) },
      { label: 'Total Production', value: k => qtl(k.totalProduction) },
    ],
    cardFields: [
      { label: 'Name',        of: r => r.collective_name },
      { label: 'Lead Person', of: r => r.lead_person_name },
      { label: 'Mobile',      of: r => r.contact_no },
      { label: 'Type',        of: r => r.collective_type },
      { label: 'State',       of: r => r.state },
      { label: 'District',    of: r => r.district },
      { label: 'Block',       of: r => r.block },
      { label: 'Panchayat',   of: r => r.panchayat },
      { label: 'Village',     of: r => r.village },
    ],
  },
]

// Indirect Beneficiaries (XB-) have no roster tab, but the profile endpoint
// still resolves their UIDs, so the ID card needs a field list for them.
const INDIRECT_CARD_FIELDS: CardField[] = [
  { label: 'Name',   of: r => r.name },
  { label: 'Mobile', of: r => r.contact_no },
  { label: 'Place',  of: r => r.place },
]

// typeLabel is the profile endpoint's `type` value (beneficiaryLookupSpec).
function cardFieldsForType(typeLabel: string): CardField[] {
  return CATEGORIES.find(c => c.label === typeLabel)?.cardFields ?? INDIRECT_CARD_FIELDS
}

// ── Field labels + formatting for the "complete detail" grid ──────────────
const HIDDEN_FIELDS = new Set(['id', 'org_id'])
const CURRENCY_FIELDS = ['income_inr', 'revenue_inr', 'credit_access_inr', 'amount']
const DATE_FIELDS = ['created_at', '_date']
const BOOLEAN_LABELS: Record<string, string> = { true: 'Yes', false: 'No' }

function humanizeKey(key: string): string {
  return key
    .replace(/_inr$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    if (!value.length) return '—'
    // Livestock is a headcount; the other systems are in Quintal.
    if (key === 'production_systems') return value.map(p => `${p.type}: ${p.type === 'Livestock' ? (p.livestock_count ?? '—') : (p.production_quintal != null ? `${p.production_quintal} qtl` : '—')}`).join(', ')
    return value.map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(', ')
  }
  if (typeof value === 'boolean') return BOOLEAN_LABELS[String(value)]
  if (CURRENCY_FIELDS.some(f => key.endsWith(f)) && typeof value === 'number') return inr(value)
  if (DATE_FIELDS.some(f => key.endsWith(f)) && typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  }
  if (key.endsWith('_ton') && typeof value === 'number') return `${value.toLocaleString('en-IN')} ton`
  return String(value)
}

function DetailGrid({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record).filter(([k]) => !HIDDEN_FIELDS.has(k))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px 20px' }}>
      {entries.map(([key, value]) => (
        <div key={key}>
          <div style={{ fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint }}>{humanizeKey(key)}</div>
          <div style={{ fontSize: 13.5, color: FF.tealDark, fontWeight: 500, marginTop: 3, wordBreak: 'break-word' }}>
            {formatFieldValue(key, value)}
          </div>
        </div>
      ))}
    </div>
  )
}

// Read-only even in edit mode. The server ignores writes to uid/created_at
// (PROTECTED_COLUMNS), and production_systems is a JSONB array that needs the
// registration form's editor rather than a plain input.
const READONLY_DETAIL_FIELDS = new Set(['uid', 'created_at', 'production_systems'])

// Columns with DB CHECK constraints get a <select> so a typo can't be rejected
// by the constraint.
const FIELD_OPTIONS: Record<string, string[]> = {
  gender:          ['Male', 'Female', 'Other'],
  category:        ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority'],
  production_type: ['Aquaculture', 'Agriculture'],
}

const editableFieldLabelStyle = { fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase' as const, color: FF.textFaint }
const editableFieldInputStyle = {
  width: '100%', marginTop: 3, fontSize: 13.5, color: FF.tealDark, fontWeight: 500,
  padding: '5px 8px', borderRadius: 6, border: `1px solid ${FF.borderSoft}`, background: '#fff',
  fontFamily: "'IBM Plex Sans',sans-serif", boxSizing: 'border-box' as const,
}

// Edit-mode twin of DetailGrid (admins only). Booleans get a Yes/No select so
// a typo can't coerce a bool column to a string server-side.
function EditableDetailGrid({ record, draft, onChange }: {
  record: Record<string, unknown>
  draft: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}) {
  const entries = Object.entries(record).filter(([k]) => !HIDDEN_FIELDS.has(k))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px 20px' }}>
      {entries.map(([key, value]) => {
        if (READONLY_DETAIL_FIELDS.has(key)) {
          return (
            <div key={key}>
              <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
              <div style={{ fontSize: 13.5, color: FF.tealDark, fontWeight: 500, marginTop: 3, wordBreak: 'break-word' }}>
                {formatFieldValue(key, value)}
              </div>
            </div>
          )
        }
        const current = draft[key]
        if (FIELD_OPTIONS[key]) {
          return (
            <div key={key}>
              <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
              <select
                value={(current ?? '') as string}
                onChange={e => onChange(key, e.target.value === '' ? null : e.target.value)}
                style={editableFieldInputStyle}
              >
                <option value="">—</option>
                {FIELD_OPTIONS[key].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          )
        }
        if (typeof value === 'boolean') {
          return (
            <div key={key}>
              <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
              <select
                value={current === true ? 'true' : current === false ? 'false' : ''}
                onChange={e => onChange(key, e.target.value === '' ? null : e.target.value === 'true')}
                style={editableFieldInputStyle}
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          )
        }
        const isNumber = typeof value === 'number'
        return (
          <div key={key}>
            <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
            <input
              type={isNumber ? 'number' : 'text'}
              value={(current ?? '') as string | number}
              onChange={e => onChange(key, isNumber ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
              style={editableFieldInputStyle}
            />
          </div>
        )
      })}
    </div>
  )
}

// Generic MIS record table. The Project column is per row (the project open
// when the sheet was uploaded), so it can differ from the beneficiary's
// enrolled projects.
function MisTable<T extends { id: string; created_at: string; project_name: string }>({
  title, rows, primaryLabel, primaryOf, dateOf, placeOf, extra, onAdd,
}: {
  title: string
  rows: T[]
  primaryLabel: string
  primaryOf: (r: T) => string
  dateOf: (r: T) => string | null
  placeOf?: (r: T) => string | null
  extra?: { label: string; of: (r: T) => string }
  onAdd?: () => void
}) {
  const cols = extra ? '1.2fr 1fr 100px 1fr 1fr' : '1.3fr 100px 1fr 1fr'
  const addButton = onAdd && (
    <button
      onClick={onAdd}
      className="flex items-center gap-1.5 rounded-lg text-xs font-semibold shrink-0"
      style={{ padding: '6px 10px', background: FF.purple, color: '#fff' }}
    >
      <PlusCircle className="w-3.5 h-3.5" /> Add
    </button>
  )
  return (
    <SectionCard title={`${title} (${rows.length})`} titleRight={addButton}>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: FF.textFaint, padding: '4px 0' }}>No {title.toLowerCase()} records for this beneficiary.</div>
      ) : (
        <>
          {/* Grid table at md and up; cards below (too cramped otherwise). */}
          <div className="hidden md:flex md:flex-col" style={{ gap: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '8px 0', fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}` }}>
              <div>{primaryLabel}</div>
              {extra && <div>{extra.label}</div>}
              <div>Date</div>
              <div>Place</div>
              <div>Project</div>
            </div>
            {rows.map(r => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13 }}>
                <div style={{ color: FF.tealDark, fontWeight: 500 }}>{primaryOf(r)}</div>
                {extra && <div style={{ color: FF.textMuted, fontSize: 12 }}>{extra.of(r)}</div>}
                <div style={{ color: FF.textMuted, fontSize: 12 }}>{formatFieldValue('x_date', dateOf(r))}</div>
                <div style={{ color: FF.textMuted, fontSize: 12 }}>{(placeOf ? placeOf(r) : (r as any).place) || '—'}</div>
                <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.project_name || '—'}</div>
              </div>
            ))}
          </div>

          <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
            {rows.map(r => (
              <div key={r.id} className="py-3">
                <div className="flex items-start justify-between gap-2">
                  <div style={{ color: FF.tealDark, fontWeight: 500, fontSize: 13.5 }}>{primaryOf(r)}</div>
                  <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{formatFieldValue('x_date', dateOf(r))}</div>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                  {extra && <div>{extra.label}: {extra.of(r)}</div>}
                  <div>Place: {(placeOf ? placeOf(r) : (r as any).place) || '—'}</div>
                  <div>Project: {r.project_name || '—'}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  )
}

// Resources registered against this UID by services/resource. They're org-wide,
// not project-scoped, so there's no Project column.
function resourceUtilitySummary(entries: ResourceRow['resource_utility']): string {
  if (!entries || entries.length === 0) return '—'
  return entries.map(e => `${e.utility}${e.production_kg != null ? `: ${e.production_kg} kg` : ''}`).join(', ')
}

function resourceDetailOf(r: ResourceRow): string {
  if (r.resource_type === 'Freshwater Wetland') {
    return [r.water_body_type, r.resource_access].filter(Boolean).join(' · ') || '—'
  }
  if (r.resource_type === 'Coastal Wetland') {
    if (r.wetland_structure === 'Raft') return `Raft${r.raft_count != null ? ` (${r.raft_count})` : ''}`
    return r.wetland_structure || '—'
  }
  return r.area_acre != null ? `${r.area_acre} acre` : '—'
}

function ResourceTable({ rows }: { rows: ResourceRow[] }) {
  const cols = '110px 1.1fr 1fr 1.2fr 1fr'
  return (
    <SectionCard title={`Resources (${rows.length})`}>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: FF.textFaint, padding: '4px 0' }}>No resources registered for this beneficiary.</div>
      ) : (
        <>
          {/* Grid table at md and up; cards below. */}
          <div className="hidden md:flex md:flex-col" style={{ gap: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '8px 0', fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}` }}>
              <div>UID</div><div>Type</div><div>Detail</div><div>Utility</div><div>Date</div>
            </div>
            {rows.map(r => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13 }}>
                <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.resource_type}</div>
                <div style={{ color: FF.textMuted, fontSize: 12 }}>{resourceDetailOf(r)}</div>
                <div style={{ color: FF.textMuted, fontSize: 12 }}>{resourceUtilitySummary(r.resource_utility)}</div>
                <div style={{ color: FF.textMuted, fontSize: 12 }}>{formatFieldValue('x_date', r.created_at)}</div>
              </div>
            ))}
          </div>

          <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
            {rows.map(r => (
              <div key={r.id} className="py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                    <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 13.5 }}>{r.resource_type}</div>
                  </div>
                  <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{formatFieldValue('x_date', r.created_at)}</div>
                </div>
                <div className="mt-1.5" style={{ fontSize: 12, color: FF.textMuted }}>
                  <div>Detail: {resourceDetailOf(r)}</div>
                  <div>Utility: {resourceUtilitySummary(r.resource_utility)}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  )
}

// Read-only view of beneficiary_project_links. projectDot/projectBadge keep a
// project's colour consistent across the app.
function ProjectChips({ projects }: { projects: LinkedProject[] }) {
  return (
    <SectionCard title={`Projects (${projects.length})`}>
      {projects.length === 0 ? (
        <div style={{ fontSize: 13, color: FF.textFaint, padding: '4px 0' }}>Not linked to any project yet.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {projects.map(p => (
            <span
              key={p.project_key}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
                background: projectBadge(p.name), color: FF.tealDark,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: projectDot(p.name), flexShrink: 0 }} />
              {p.name}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// Printable CR80-shaped ID card (aspect 1.586), white-labelled per tenant. The
// QR image is passed in because it needs an authenticated fetch.
function cardVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

function BeneficiaryIdCard({
  row, uid, fields, qrImgUrl, orgName, logoUrl, accent,
}: {
  row: Record<string, unknown>
  uid: string
  fields: CardField[]
  qrImgUrl: string | null
  orgName: string
  logoUrl?: string | null
  accent: string
}) {
  return (
    <div
      className="ff-id-card"
      style={{
        width: 460, aspectRatio: '1.586', background: '#fff', borderRadius: 18,
        border: `1.5px solid ${FF.border}`, boxShadow: '0 6px 18px rgba(14,58,70,0.12)',
        padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 10,
        fontFamily: "'IBM Plex Sans',sans-serif", boxSizing: 'border-box',
        // Fixed height with a variable-length field list: clip rather than spill.
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 52, height: 52, borderRadius: 10, border: `1.5px solid ${accent}`, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: FF.bg,
        }}>
          {logoUrl
            ? <img src={logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span style={{ fontSize: 8.5, fontWeight: 700, color: accent, textAlign: 'center', lineHeight: 1.2 }}>ORG<br />LOGO</span>}
        </div>
        <div style={{ width: 2, alignSelf: 'stretch', background: accent, opacity: 0.5, borderRadius: 1 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 20, fontWeight: 700, color: FF.tealDark, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orgName}</div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: accent }}>Beneficiary Card</div>
        </div>
      </div>

      <div style={{ height: 1, background: FF.borderSoft }} />

      <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
        <div style={{
          flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden',
          // minmax(0, 1fr), not bare 1fr: drops each row's content-based min
          // height so the rows split the available height evenly instead of
          // overflowing into the footer bar.
          display: 'grid', gridTemplateRows: `repeat(${fields.length}, minmax(0, 1fr))`,
        }}>
          {fields.map(f => (
            <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 11, lineHeight: 1.15, minHeight: 0, overflow: 'hidden' }}>
              <div style={{ width: 72, flexShrink: 0, fontWeight: 600, color: FF.tealDark }}>{f.label}:</div>
              <div style={{ color: FF.textMuted, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cardVal(f.of(row))}</div>
            </div>
          ))}
        </div>
        <div style={{ width: 116, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 108, height: 108, borderRadius: 10, border: `1.5px solid ${accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
            {qrImgUrl
              ? <img src={qrImgUrl} alt={`QR code for ${uid}`} style={{ width: 98, height: 98 }} />
              : <Loader2 className="w-5 h-5 animate-spin" style={{ color: FF.textFaint }} />}
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, color: FF.tealDark, fontFamily: 'monospace', textAlign: 'center', wordBreak: 'break-all' }}>{uid}</div>
        </div>
      </div>

      <div style={{ display: 'flex', borderRadius: 10, overflow: 'hidden', border: `1.5px solid ${FF.tealDark}` }}>
        <div style={{ background: FF.tealDark, color: '#fff', fontSize: 11.5, fontWeight: 700, padding: '7px 14px', whiteSpace: 'nowrap' }}>Beneficiary ID</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: FF.tealDark, fontFamily: 'monospace', letterSpacing: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{uid}</div>
      </div>
    </div>
  )
}

// Print CSS for both card modals: only the card(s) print; .ff-id-card-chrome
// never does. print-color-adjust keeps the teal footer bar from printing
// white-on-white, the card keeps its on-screen px size (its padding/fonts are
// px-tuned), and the backdrop drops position:fixed in print because fixed
// ancestors don't paginate, which would clip bulk prints to one page.
const ID_CARD_PRINT_CSS = `
  @page {
    margin: 0.35in;
  }
  @media print {
    body * { visibility: hidden !important; }
    .ff-id-card-print, .ff-id-card-print * { visibility: visible !important; }

    .ff-id-card-modal-backdrop {
      position: static !important;
      overflow: visible !important;
      background: #fff !important;
      height: auto !important;
    }
    .ff-id-card-print {
      /* top/left/right only, deliberately NOT bottom — 'inset: 0' would pin
         bottom too, which computes a height capped to exactly one page and
         clips the bulk grid's later cards instead of letting them paginate.
         Leaving height auto lets the box grow to fit however many cards
         there are. */
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      background: #fff !important;
      padding: 0.1in !important;
    }
    .ff-id-card, .ff-id-card * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    .ff-id-card {
      box-shadow: none !important;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .ff-id-card-chrome { display: none !important; }
  }
`

function useCardBranding() {
  const { org } = useOrg()
  return {
    orgName: org?.branding.org_name || 'Organisation',
    logoUrl: org?.branding.logo_url || null,
    accent:  org?.branding.theme?.primary || FF.purple,
  }
}

// The QR endpoint needs auth, so fetch it as a blob rather than a bare <img src>.
// The raw blob backs the "QR only" download.
function useQrImage(uid: string) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const blobRef = useRef<Blob | null>(null)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setLoading(true)
    setError(null)
    apiFetch(`/api/beneficiary-profile/${encodeURIComponent(uid)}/qrcode?size=480`)
      .then(async r => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}))
          throw new Error(d.error || 'Could not generate QR code')
        }
        const blob = await r.blob()
        if (cancelled) return
        blobRef.current = blob
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Network error') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [uid])

  return { loading, error, url, blobRef }
}

function BeneficiaryIdCardModal({ row, uid, fields, onClose }: {
  row: Record<string, unknown>; uid: string; fields: CardField[]; onClose: () => void
}) {
  const { orgName, logoUrl, accent } = useCardBranding()
  const { loading, error, url, blobRef } = useQrImage(uid)

  return (
    <div
      onClick={onClose}
      className="ff-id-card-modal-backdrop"
      style={{ position: 'fixed', inset: 0, background: 'rgba(14,58,70,0.5)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto' }}
    >
      <style>{ID_CARD_PRINT_CSS}</style>
      <div onClick={e => e.stopPropagation()} className="ff-id-card-print" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div className="ff-id-card-chrome" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: 460 }}>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 16, fontWeight: 600, color: '#fff' }}>Beneficiary ID Card</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X className="w-4 h-4" style={{ color: '#fff' }} />
          </button>
        </div>

        {error ? (
          <div className="ff-id-card-chrome rounded-2xl border-2 border-dashed p-6 text-center text-sm" style={{ borderColor: FF.red, background: '#fff', color: FF.red, width: 460 }}>{error}</div>
        ) : (
          <BeneficiaryIdCard row={row} uid={uid} fields={fields} qrImgUrl={url} orgName={orgName} logoUrl={logoUrl} accent={accent} />
        )}

        <div className="ff-id-card-chrome" style={{ display: 'flex', gap: 10, width: 460 }}>
          <button
            disabled={loading || !!error}
            onClick={() => window.print()}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ padding: '11px 0', background: '#fff', color: FF.tealDark }}
          >
            <Printer className="w-4 h-4" /> Print ID Card
          </button>
          <button
            disabled={!url}
            onClick={() => { if (blobRef.current) saveAs(blobRef.current, `${uid}_qr.png`) }}
            className="flex items-center justify-center gap-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ padding: '11px 16px', background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}
          >
            <Download className="w-4 h-4" /> QR only
          </button>
        </div>
        <p className="ff-id-card-chrome" style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.75)', textAlign: 'center', margin: 0, width: 460 }}>
          Scanning the code opens this beneficiary's full profile directly. Print uses your browser's print dialog — choose "Save as PDF" there if you don't have a card printer handy.
        </p>
      </div>
    </div>
  )
}

// Prints every card on the current roster page. Scoped to one page (≤ pageSize)
// on purpose so it never fetches thousands of QR images at once.
function BulkIdCardModal({ rows, fields, onClose }: {
  rows: RosterRow[]; fields: CardField[]; onClose: () => void
}) {
  const { orgName, logoUrl, accent } = useCardBranding()
  const [loading, setLoading] = useState(true)
  const [qrByUid, setQrByUid] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []
    setLoading(true)
    Promise.all(rows.map(async r => {
      try {
        const res = await apiFetch(`/api/beneficiary-profile/${encodeURIComponent(r.uid)}/qrcode?size=300`)
        if (!res.ok || cancelled) return
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        objectUrls.push(url)
        if (!cancelled) setQrByUid(prev => ({ ...prev, [r.uid]: url }))
      } catch {
        // Skip it: the card still renders with a spinner instead of failing the batch.
      }
    })).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; objectUrls.forEach(u => URL.revokeObjectURL(u)) }
  }, [rows])

  return (
    <div onClick={onClose} className="ff-id-card-modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(14,58,70,0.55)', zIndex: 70, overflowY: 'auto', padding: 24 }}>
      <style>{ID_CARD_PRINT_CSS}</style>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="ff-id-card-chrome" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0 }}>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 17, fontWeight: 600, color: '#fff' }}>
            Print ID Cards ({rows.length}){loading ? ' · generating QR codes…' : ''}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              disabled={loading}
              onClick={() => window.print()}
              className="flex items-center gap-2 rounded-lg text-sm font-semibold disabled:opacity-40"
              style={{ padding: '10px 18px', background: '#fff', color: FF.tealDark }}
            >
              <Printer className="w-4 h-4" /> Print All
            </button>
            <button onClick={onClose} style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X className="w-4 h-4" style={{ color: '#fff' }} />
            </button>
          </div>
        </div>
        <div className="ff-id-card-print" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 20 }}>
          {rows.map(r => (
            <BeneficiaryIdCard
              key={r.uid} row={r} uid={r.uid} fields={fields}
              qrImgUrl={qrByUid[r.uid] || null} orgName={orgName} logoUrl={logoUrl} accent={accent}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// Shared by the roster overlay and BeneficiaryPublicProfilePage (the QR landing page).
export function useBeneficiaryProfile(uid: string) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<BeneficiaryProfileResponse | null>(null)

  // cancelledRef stops a fetch for a previous uid from clobbering the current one.
  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      const r = await apiFetch(`/api/beneficiary-profile/${encodeURIComponent(uid)}`)
      const d = await r.json()
      if (cancelledRef?.current) return
      if (!r.ok) { setError(d.error || 'Could not load beneficiary profile'); return }
      setData(d)
    } catch (e: any) {
      if (!cancelledRef?.current) setError(e.message || 'Network error')
    } finally {
      if (!cancelledRef?.current) setLoading(false)
    }
  }, [uid])

  useEffect(() => {
    const cancelledRef = { current: false }
    load(cancelledRef)
    return () => { cancelledRef.current = true }
  }, [load])

  // refetch is uncancellable; it only runs after a modal save.
  return { loading, error, data, refetch: useCallback(() => load(), [load]) }
}

// authedDownload because a plain <a href> can't carry the Bearer token.
export async function downloadBeneficiaryProfilePdf(uid: string): Promise<void> {
  await authedDownload(`/api/beneficiary-profile/${encodeURIComponent(uid)}/export.pdf`, `${uid}_profile.pdf`)
}

// Admin-only server-side. The server ignores unknown or protected columns, so
// sending the whole draft (not just changed keys) is fine.
async function updateBeneficiaryProfile(uid: string, updates: Record<string, unknown>): Promise<BeneficiaryProfileResponse> {
  const r = await apiFetch(`/api/beneficiary-profile/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: updates }),
  })
  // A proxy/App Engine error page is HTML, so r.json() can throw before the !r.ok check.
  let d: any
  try {
    d = await r.json()
  } catch {
    throw new Error(r.ok ? 'Server returned an invalid response' : `Could not save changes (HTTP ${r.status})`)
  }
  if (!r.ok) throw new Error(d.error || 'Could not save changes')
  return d
}

/**
 * `data.profile`'s display name, whichever registry it came from. `name` is
 * checked first: an individual who belongs to a collective also has
 * `collective_name` (their group's name), which must not win.
 */
export function beneficiaryDisplayName(data: BeneficiaryProfileResponse | null, fallbackUid: string): string {
  return data ? (data.profile as any).name ?? (data.profile as any).collective_name ?? data.uid : fallbackUid
}

// Also rendered read-only by BeneficiaryPublicProfilePage (the QR landing page),
// which omits the edit props. `editable` (any editor) only gates adding
// interventions; `canEditProfile` (admins only) gates editing Complete Detail.
export function BeneficiaryProfileDetail({ data, uid, editable, onRecordAdded, canEditProfile, onProfileSaved }: {
  data: BeneficiaryProfileResponse
  uid?: string
  editable?: boolean
  onRecordAdded?: () => void
  canEditProfile?: boolean
  onProfileSaved?: () => void
}) {
  const [addingCategory, setAddingCategory] = useState<InterventionCategoryConfig | null>(null)
  const categoryFor = (apiCategory: string) => INTERVENTION_CATEGORIES.find(c => c.apiCategory === apiCategory)
  const addHandler = (apiCategory: string) => editable && uid ? () => setAddingCategory(categoryFor(apiCategory) || null) : undefined

  const [editingProfile, setEditingProfile] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(data.profile as unknown as Record<string, unknown>) }))
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null)

  // Re-seed on every new profile so a stale edit never carries over.
  useEffect(() => {
    setDraft({ ...(data.profile as unknown as Record<string, unknown>) })
  }, [data.profile])

  const startEdit = () => {
    setDraft({ ...(data.profile as unknown as Record<string, unknown>) })
    setProfileSaveError(null)
    setEditingProfile(true)
  }
  const cancelEdit = () => {
    setDraft({ ...(data.profile as unknown as Record<string, unknown>) })
    setProfileSaveError(null)
    setEditingProfile(false)
  }
  const saveProfile = async () => {
    if (!uid) return
    setSavingProfile(true)
    setProfileSaveError(null)
    try {
      // draft is a full copy of the profile; drop read-only fields before sending.
      const updates = { ...draft }
      for (const key of READONLY_DETAIL_FIELDS) delete updates[key]
      await updateBeneficiaryProfile(uid, updates)
      setEditingProfile(false)
      onProfileSaved?.()
    } catch (e: any) {
      setProfileSaveError(e.message || 'Could not save changes')
    } finally {
      setSavingProfile(false)
    }
  }

  return (
    <>
      <SectionCard
        title="Complete Detail"
        titleRight={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: FF.textFaint }}>{data.misRecordCount} Intervention record{data.misRecordCount === 1 ? '' : 's'}</span>
            {canEditProfile && uid && !editingProfile && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 rounded-lg text-xs font-semibold shrink-0"
                style={{ padding: '6px 10px', background: FF.purple, color: '#fff' }}
              >
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            {editingProfile && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={cancelEdit}
                  disabled={savingProfile}
                  className="rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ padding: '6px 10px', background: 'transparent', border: `1px solid ${FF.borderSoft}`, color: FF.textMuted }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveProfile}
                  disabled={savingProfile}
                  className="flex items-center gap-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ padding: '6px 10px', background: FF.purple, color: '#fff' }}
                >
                  {savingProfile && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                </button>
              </div>
            )}
          </div>
        }
      >
        {profileSaveError && (
          <div className="rounded-xl p-2.5 text-xs" style={{ marginBottom: 12, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}>{profileSaveError}</div>
        )}
        {editingProfile
          ? <EditableDetailGrid record={data.profile as unknown as Record<string, unknown>} draft={draft} onChange={(key, value) => setDraft(d => ({ ...d, [key]: value }))} />
          : <DetailGrid record={data.profile as unknown as Record<string, unknown>} />}
      </SectionCard>

      <ProjectChips projects={data.projects} />

      <div>
        <div style={{ fontFamily: "'Newsreader',serif", fontSize: 16, fontWeight: 600, color: FF.tealDark, margin: '4px 0 12px' }}>Resources</div>
        <ResourceTable rows={data.resources} />
      </div>

      <div>
        <div style={{ fontFamily: "'Newsreader',serif", fontSize: 16, fontWeight: 600, color: FF.tealDark, margin: '4px 0 12px' }}>Intervention Recorded Data</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <MisTable<TrainingRow> title="Training" rows={data.mis.training} primaryLabel="Topic" primaryOf={r => r.training_topic} dateOf={r => r.training_date} onAdd={addHandler('training')} />
          <MisTable<InputDistributionRow> title="Input Distribution" rows={data.mis.inputDistribution} primaryLabel="Input Distributed" primaryOf={r => r.input_distributed} dateOf={r => r.distribution_date} onAdd={addHandler('inputDistribution')} />
          <MisTable<SchemeAccessRow> title="Scheme Access" rows={data.mis.schemeAccess} primaryLabel="Scheme" primaryOf={r => r.scheme_name} dateOf={r => r.access_date} onAdd={addHandler('schemeAccess')} />
          <MisTable<CreditGrantAccessRow>
            title="Credit/Grant Access" rows={data.mis.creditGrantAccess} primaryLabel="Source" primaryOf={r => r.credit_grant_source}
            dateOf={r => r.access_date} extra={{ label: 'Amount', of: r => inr(r.amount) }} onAdd={addHandler('creditGrantAccess')}
          />
          <MisTable<BusinessDevelopmentSupportRow> title="Business Development Support" rows={data.mis.businessDevelopmentSupport} primaryLabel="Support Provided" primaryOf={r => r.support_provided} dateOf={r => r.support_date} onAdd={addHandler('businessDevelopmentSupport')} />
          <MisTable<ComplianceSupportRow> title="Compliance Support" rows={data.mis.complianceSupport} primaryLabel="Support Provided" primaryOf={r => r.compliance_support_provided} dateOf={r => r.support_date} onAdd={addHandler('complianceSupport')} />
          <MisTable<ExposureVisitRow>
            title="Exposure Visit" rows={data.mis.exposureVisit} primaryLabel="Purpose" primaryOf={r => r.purpose}
            dateOf={r => r.visit_date} placeOf={r => r.visit_place} onAdd={addHandler('exposureVisit')}
          />
          <MisTable<IncomeRow>
            title="Income" rows={data.mis.income} primaryLabel="Source" primaryOf={r => r.income_source}
            dateOf={r => r.financial_year} extra={{ label: 'Amount', of: r => inr(r.income_realised) }} onAdd={addHandler('income')}
          />
        </div>
      </div>

      {addingCategory && uid && (
        <AddInterventionModal
          uid={uid}
          category={addingCategory}
          onClose={() => setAddingCategory(null)}
          onSaved={() => { setAddingCategory(null); onRecordAdded?.() }}
        />
      )}
    </>
  )
}

function BeneficiaryDetailOverlay({ uid, onClose }: { uid: string; onClose: () => void }) {
  const { loading, error, data, refetch } = useBeneficiaryProfile(uid)
  const { user } = useAuthContext()
  // Editing core registered data is admin-only (matches requireAdmin server-side).
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const [showQr, setShowQr] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const displayName = beneficiaryDisplayName(data, uid)

  const handleDownloadPdf = async () => {
    setDownloadingPdf(true); setPdfError(null)
    try {
      await downloadBeneficiaryProfilePdf(uid)
    } catch (e: any) {
      setPdfError(e.message || 'Download failed')
    } finally {
      setDownloadingPdf(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(14,58,70,0.45)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(920px, 96vw)', height: '100%', background: FF.bg, overflowY: 'auto', boxShadow: '-8px 0 24px rgba(0,0,0,0.15)' }}
      >
        <div className="px-4 py-3.5 sm:px-7 sm:py-5" style={{ position: 'sticky', top: 0, background: FF.tealDark, display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 1 }}>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="shrink-0" style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <User className="w-5 h-5" style={{ color: '#fff' }} />
            </div>
            <div className="min-w-0">
              <div className="truncate" style={{ fontFamily: "'Newsreader',serif", fontSize: 19, fontWeight: 600, color: '#fff' }}>{displayName}</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', fontFamily: 'monospace' }}>{uid} {data ? `· ${data.type}` : ''}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleDownloadPdf}
              disabled={downloadingPdf}
              title="Download profile as PDF"
              style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {downloadingPdf ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#fff' }} /> : <Download className="w-4 h-4" style={{ color: '#fff' }} />}
            </button>
            <button
              onClick={() => setShowQr(true)}
              title="Print ID card"
              style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <QrCode className="w-4 h-4" style={{ color: '#fff' }} />
            </button>
            <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <X className="w-4 h-4" style={{ color: '#fff' }} />
            </button>
          </div>
        </div>
        {showQr && data && (
          <BeneficiaryIdCardModal
            row={data.profile as unknown as Record<string, unknown>}
            uid={uid}
            fields={cardFieldsForType(data.type)}
            onClose={() => setShowQr(false)}
          />
        )}

        <div className="p-4 sm:p-6" style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: "'IBM Plex Sans',sans-serif" }}>
          {pdfError && (
            <div className="rounded-xl p-3 text-xs" style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}>{pdfError}</div>
          )}
          {loading && (
            <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
          )}
          {error && !loading && (
            <div className="rounded-2xl border-2 border-dashed p-8 text-center" style={{ borderColor: FF.red, color: FF.red }}>{error}</div>
          )}
          {data && !loading && !error && (
            <BeneficiaryProfileDetail data={data} uid={uid} editable onRecordAdded={refetch} canEditProfile={isAdmin} onProfileSaved={refetch} />
          )}
        </div>
      </div>
    </div>
  )
}

function CategoryRoster({ config, onSelectUid, onShowCard, onBulkPrint }: {
  config: CategoryConfig
  onSelectUid: (uid: string) => void
  onShowCard: (row: RosterRow) => void
  onBulkPrint: (rows: RosterRow[]) => void
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<RosterData>(EMPTY_ROSTER)
  const [state, setState] = useState('')
  const [district, setDistrict] = useState('')
  const [block, setBlock] = useState('')
  const [village, setVillage] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  // Selection survives paging and filtering, so it stores full rows (a row from
  // an earlier page is gone from data.rows). Cleared only explicitly or on tab switch.
  const [selected, setSelected] = useState<Map<string, RosterRow>>(new Map())
  const [exporting, setExporting] = useState(false)
  // requestId drops stale responses that land after a newer query's.
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams()
      if (state) params.set('state', state)
      if (district) params.set('district', district)
      if (block) params.set('block', block)
      if (village) params.set('village', village)
      if (debouncedSearch) params.set('search', debouncedSearch)
      params.set('page', String(page))
      const r = await apiFetch(`${config.endpoint}?${params}`)
      const d = await r.json()
      if (id !== requestId.current) return
      if (!r.ok) {
        setLoadError(d.error || `Could not load ${config.label.toLowerCase()} records`)
        setData(EMPTY_ROSTER)
        return
      }
      setData({ ...EMPTY_ROSTER, ...d })
    } catch (e: any) {
      if (id !== requestId.current) return
      setLoadError(e.message || 'Network error')
      setData(EMPTY_ROSTER)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [config.endpoint, state, district, block, village, debouncedSearch, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(0) }, [state, district, block, village, debouncedSearch])
  useEffect(() => { setPage(0); setState(''); setDistrict(''); setBlock(''); setVillage(''); setSearch(''); setSelected(new Map()) }, [config.endpoint])

  const pageCount = Math.max(1, Math.ceil(data.totalRows / data.pageSize))
  const allOnPageSelected = data.rows.length > 0 && data.rows.every(r => selected.has(r.uid))
  const toggleAll = () => setSelected(prev => {
    const next = new Map(prev)
    if (allOnPageSelected) data.rows.forEach(r => next.delete(r.uid))
    else data.rows.forEach(r => next.set(r.uid, r))
    return next
  })
  const toggleOne = (row: RosterRow) => setSelected(prev => {
    const next = new Map(prev)
    if (next.has(row.uid)) next.delete(row.uid); else next.set(row.uid, row)
    return next
  })
  const selectedRows = [...selected.values()]

  // Excel export of the CHECKED rows only (not the whole page/filtered set —
  // "selection" here means the checkboxes above, mirroring how the bulk
  // print button already treats a selection). Built client-side since the
  // roster rows are already in memory; humanizeKey (defined above, shared
  // with the Complete Detail grid) turns raw column names into sheet
  // headers instead of exporting e.g. "current_income_inr" verbatim.
  const handleExportSelected = async () => {
    if (!selectedRows.length) return
    setExporting(true)
    try {
      const XLSX: any = await import('xlsx')
      const exportRows = selectedRows.map(r => {
        const out: Record<string, unknown> = {}
        Object.entries(r).forEach(([k, v]) => {
          if (k === 'id') return
          out[humanizeKey(k)] = v
        })
        return out
      })
      const ws = XLSX.utils.json_to_sheet(exportRows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, config.label.slice(0, 31))
      const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
      saveAs(new Blob([buf], { type: 'application/octet-stream' }), `${config.label.replace(/\s+/g, '_')}_selected.xlsx`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="flex items-center gap-3 flex-wrap">
        {/* State/District/Block/Village options are now scoped server-side
            to whichever ANCESTOR filters are already picked (see
            routes/individual-beneficiaries.routes.js's scopedDistinct) —
            so picking a new ancestor must also clear its now-stale
            descendants here, or a leftover District from a different State
            would keep being sent and silently zero out the results. */}
        <select value={state} onChange={e => { setState(e.target.value); setDistrict(''); setBlock(''); setVillage('') }} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All States</option>
          {data.states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={district} onChange={e => { setDistrict(e.target.value); setBlock(''); setVillage('') }} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Districts</option>
          {data.districts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={block} onChange={e => { setBlock(e.target.value); setVillage('') }} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Blocks</option>
          {data.blocks.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={village} onChange={e => setVillage(e.target.value)} className="rounded-lg px-3 py-2 text-sm outline-none" style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}>
          <option value="">All Villages</option>
          {data.villages.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <div style={{ position: 'relative', minWidth: 240 }}>
          <Search className="w-3.5 h-3.5" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: FF.textFaint }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={config.searchPlaceholder}
            className="rounded-lg pl-8 pr-3 py-2 text-sm outline-none w-full"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
          />
        </div>
        {(data.rows.length > 0 || selectedRows.length > 0) && (
          <button
            onClick={() => onBulkPrint(selectedRows.length > 0 ? selectedRows : data.rows)}
            title={selectedRows.length > 0 ? 'Print an ID card for each selected beneficiary (across however many pages you picked them from)' : 'Print an ID card for every beneficiary on this page'}
            className="ml-auto flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, background: '#fff' }}
          >
            <Printer className="w-3.5 h-3.5" />
            {selectedRows.length > 0 ? `Print Selected (${selectedRows.length})` : `Print ID Cards (${data.rows.length})`}
          </button>
        )}
        {selectedRows.length > 0 && (
          <button
            onClick={handleExportSelected}
            disabled={exporting}
            title="Download the selected beneficiaries as an Excel file"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, background: '#fff' }}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            Download Excel ({selectedRows.length})
          </button>
        )}
        {selectedRows.length > 0 && (
          <button
            onClick={() => setSelected(new Map())}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold"
            style={{ color: FF.textMuted }}
          >
            Clear selection
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : loadError ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.red, background: '#FFFFFF', color: FF.red }}>
          {loadError}
        </div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No {config.label.toLowerCase()} records found.
        </div>
      ) : (
        <>
          <KpiGrid cols={config.kpiTiles.length}>
            {config.kpiTiles.map(kt => (
              <KpiTile key={kt.label} label={kt.label} value={kt.value(data.kpis)} note={kt.note?.(data.kpis)} />
            ))}
          </KpiGrid>

          <SectionCard
            title="By Type of Production System"
            titleRight={<span className="text-[11px]" style={{ color: FF.textFaint }}>No. of {config.label.toLowerCase()} records per system · one can be in several</span>}
          >
            <KpiGrid cols={PRODUCTION_TILES.length}>
              {PRODUCTION_TILES.map(pt => (
                <KpiTile key={pt.label} label={pt.label} value={data.kpis[pt.countKey] ?? 0} note={pt.note(data.kpis)} />
              ))}
            </KpiGrid>
          </SectionCard>

          <SectionCard noPadding>
            {/* Desktop/tablet — real grid "table" (≥ md; below that a
                7-column layout would need 800px+ to stay legible, so the
                same rows render as cards instead — see the md:hidden block
                below). */}
            <div className="hidden md:flex md:flex-col">
              <div style={{ display: 'grid', gridTemplateColumns: '28px 110px 1.3fr 1fr 110px 100px 90px 36px', gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}` }}>
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} title="Select all on this page" style={{ width: 15, height: 15, cursor: 'pointer' }} />
                <div>UID</div><div>Name</div><div>Detail</div><div>Contact</div><div>Location</div><div /><div />
              </div>
              {data.rows.map(r => (
                <div
                  key={r.id}
                  onClick={() => onSelectUid(r.uid)}
                  className="cursor-pointer"
                  style={{ display: 'grid', gridTemplateColumns: '28px 110px 1.3fr 1fr 110px 100px 90px 36px', gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13, background: selected.has(r.uid) ? FF.bg : undefined }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.uid)}
                    onClick={e => e.stopPropagation()}
                    onChange={() => toggleOne(r)}
                    style={{ width: 15, height: 15, cursor: 'pointer' }}
                  />
                  <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                  <div style={{ color: FF.tealDark, fontWeight: 500 }}>{config.nameOf(r)}</div>
                  <div style={{ color: FF.textMuted, fontSize: 12 }}>{config.subLabelOf(r)}</div>
                  <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                  <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.village || r.block || '—'}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: FF.purple }}>View →</div>
                  <button
                    onClick={e => { e.stopPropagation(); onShowCard(r) }}
                    title="Print ID card"
                    style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${FF.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}
                  >
                    <QrCode className="w-3.5 h-3.5" style={{ color: FF.tealDark }} />
                  </button>
                </div>
              ))}
            </div>

            {/* Mobile — one card per row instead of a 7-column
                horizontally-scrolling table. */}
            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {data.rows.map(r => (
                <div key={r.id} onClick={() => onSelectUid(r.uid)} className="p-4 cursor-pointer" style={{ background: selected.has(r.uid) ? FF.bg : undefined }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={selected.has(r.uid)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleOne(r)}
                        className="shrink-0 mt-0.5"
                        style={{ width: 15, height: 15, cursor: 'pointer' }}
                      />
                      <div className="min-w-0">
                        <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.uid}</div>
                        <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{config.nameOf(r)}</div>
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); onShowCard(r) }}
                      title="Print ID card"
                      className="shrink-0"
                      style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${FF.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}
                    >
                      <QrCode className="w-3.5 h-3.5" style={{ color: FF.tealDark }} />
                    </button>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 12.5 }}>{config.subLabelOf(r)}</div>
                  <div className="mt-2 flex items-center justify-between" style={{ fontSize: 12, color: FF.textMuted }}>
                    <span>{r.contact_no || '—'} · {r.village || r.block || '—'}</span>
                    <span style={{ fontWeight: 600, color: FF.purple }}>View →</span>
                  </div>
                </div>
              ))}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40" style={{ borderColor: FF.border, color: FF.tealDark }}>Previous</button>
                <span className="text-xs" style={{ color: FF.textFaint }}>
                  Page {page + 1} of {pageCount} · {data.totalRows} records
                  {selectedRows.length > 0 && ` · ${selectedRows.length} selected across pages`}
                </span>
                <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40" style={{ borderColor: FF.border, color: FF.tealDark }}>Next</button>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}

// ── Page shell ──────────────────────────────────────────────────────────
// Note: the beneficiary QR code does NOT deep-link into this tab-based
// roster view — it points at the standalone BeneficiaryPublicProfilePage.tsx
// (path `/beneficiary/<uid>`, wired up in App.tsx) instead, so opening it
// doesn't depend on tab permissions or the dashboard's hash-routing state at
// all. See routes/beneficiary-profile.routes.js's qrcode endpoint.
export function BeneficiaryProfilePage() {
  // 'dashboard' = the org-wide Beneficiary Registration Dashboard (moved here
  // from Beneficiary and Resource Registration) — lands first, like every
  // other Dashboard tab in this app; the three categories are the rosters.
  const [category, setCategory] = useState<CategoryKey | 'dashboard'>('dashboard')
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  // Field list captured alongside the row(s) at the moment the button was
  // clicked (rather than read live off `config` while the modal is open) —
  // otherwise switching category tabs while a print modal is still open
  // would silently swap in the new tab's field list for the old tab's rows.
  const [cardTarget, setCardTarget] = useState<{ row: RosterRow; fields: CardField[] } | null>(null)
  const [bulkPrint, setBulkPrint] = useState<{ rows: RosterRow[]; fields: CardField[] } | null>(null)
  const config = CATEGORIES.find(c => c.key === category)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <p style={{ fontSize: 13, color: FF.textMuted, margin: 0 }}>
        Every registered beneficiary — Individual Beneficiary, Micro-Entrepreneur or Collective — with their
        complete registered record and every Intervention category recorded against their UID. Click any row to open the
        full profile, or the QR icon to print a scannable ID card that opens it directly.
      </p>
      <TabPill
        tabs={[{ key: 'dashboard' as const, label: 'Dashboard' }, ...CATEGORIES.map(c => ({ key: c.key, label: c.label }))]}
        active={category}
        onChange={setCategory}
      />
      {category === 'dashboard' && <BeneficiaryRegistrationDashboardPage />}
      {config && (
        <CategoryRoster
          key={category}
          config={config}
          onSelectUid={setSelectedUid}
          onShowCard={row => setCardTarget({ row, fields: config.cardFields })}
          onBulkPrint={rows => setBulkPrint({ rows, fields: config.cardFields })}
        />
      )}

      {selectedUid && <BeneficiaryDetailOverlay uid={selectedUid} onClose={() => setSelectedUid(null)} />}
      {cardTarget && (
        <BeneficiaryIdCardModal
          row={cardTarget.row}
          uid={cardTarget.row.uid}
          fields={cardTarget.fields}
          onClose={() => setCardTarget(null)}
        />
      )}
      {bulkPrint && (
        <BulkIdCardModal rows={bulkPrint.rows} fields={bulkPrint.fields} onClose={() => setBulkPrint(null)} />
      )}
    </div>
  )
}
