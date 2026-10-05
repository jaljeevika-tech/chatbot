// Org-wide bird's-eye dashboard, from two parallel fetches:
//   GET /api/action-plans/org-dashboard  → targets, health, growth chart
//   GET /api/org-dashboard/overview?fy=  → footprint, digital, impact, funnel, barriers, next steps
// Metrics with no backing data come back { available:false } and render "Not tracked yet".

import { useEffect, useState } from 'react'
import { Loader2, AlertTriangle, MapPin, TrendingDown } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF, ffStatusColors, type FFStatus } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import { ProgressBar } from '../ui/ProgressBar'
import { StatusBadge } from '../ui/StatusBadge'
import { PlanVsActualChart, type ChartMonth } from '../ui/PlanVsActualChart'

interface Kpi { label: string; value: string; note: string; fg: string }
interface HealthBucket { key: FFStatus; label: string; count: number }
interface ApProjectRow { project_key: string; name: string; budgetFmt: string; budgetUsed: number; target: number; health: FFStatus }

interface Available { value: string | number | null; available: boolean; note: string }
interface ImpactMetric { key: string; label: string; value: string | null; available: boolean; note: string }
interface OverviewProject { project_key: string; name: string; programPartner: string; budgetFmt: string; utilisedFmt: string; utilisedPct: number }
interface FunnelStage { key: string; label: string; count: number; pctOfStart: number; dropFromPrev: number }
interface Barrier { severity: FFStatus; title: string; detail: string }
interface Overview {
  filters: { fyStartYear: number; fyLabel: string; availableFYs: number[] }
  totals: { activeProjects: number; totalBudgetFmt: string; totalUtilisedFmt: string; utilisedPct: number }
  projects: OverviewProject[]
  footprint: {
    districts: number; blocks: number; panchayats: number; villages: number; directBeneficiaries: number
    institutionalPartnerships: Available; waterbodies: Available
  }
  digitalFootprint: ImpactMetric[]
  impact: ImpactMetric[]
  funnel: FunnelStage[]
  barriers: Barrier[]
  nextSteps: string[]
}

interface Props {
  onOpenProject: (projectKey: string) => void
}

export function OrgDashboardPage({ onOpenProject }: Props) {
  const [loading, setLoading] = useState(true)
  const [fy, setFy] = useState<number | null>(null)
  const [kpis, setKpis] = useState<Kpi[]>([])
  const [chart, setChart] = useState<ChartMonth[]>([])
  const [health, setHealth] = useState<HealthBucket[]>([])
  const [apRows, setApRows] = useState<ApProjectRow[]>([])
  const [ov, setOv] = useState<Overview | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const fyQ = fy ? `?fy=${fy}` : ''
    Promise.all([
      apiFetch('/api/action-plans/org-dashboard').then(r => r.json()).catch(() => ({})),
      apiFetch(`/api/org-dashboard/overview${fyQ}`).then(r => r.json()).catch(() => null),
    ])
      .then(([ap, overview]) => {
        if (cancelled) return
        setKpis(ap?.kpis || [])
        setChart(ap?.combinedChart || [])
        setHealth(ap?.healthSummary || [])
        setApRows(ap?.projectRows || [])
        setOv(overview) // fy stays null until the user picks one — the select falls back to ov.filters.fyStartYear
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fy])

  if (loading && !ov) {
    return <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
  }

  const overallKpi = kpis.find(k => k.label === 'Overall Achievement')
  const apByKey = new Map(apRows.map(r => [r.project_key, r]))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div style={{ fontSize: 20, fontWeight: 600, color: FF.tealDark }}>Organisation Dashboard</div>
          <div style={{ fontSize: 12.5, color: FF.textMuted }}>Bird's-eye view across all projects · footprint, impact, barriers &amp; next steps</div>
        </div>
        {ov?.filters && (
          <label className="flex items-center gap-2" style={{ fontSize: 12.5, color: FF.textMuted }}>
            Financial Year
            <select
              value={fy ?? ov.filters.fyStartYear}
              onChange={e => setFy(Number(e.target.value))}
              style={{ border: `1px solid ${FF.border}`, borderRadius: 8, padding: '6px 10px', fontSize: 13, color: FF.tealDark, background: '#fff' }}
            >
              {ov.filters.availableFYs.map(y => (
                <option key={y} value={y}>{`FY${y}-${String((y + 1) % 100).padStart(2, '0')}`}</option>
              ))}
            </select>
            {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: FF.textFaint }} />}
          </label>
        )}
      </div>

      <KpiGrid cols={4}>
        <KpiTile label="Active Projects" value={ov?.totals.activeProjects ?? '—'} valueSize={28} />
        <KpiTile label="Total Budget" value={ov?.totals.totalBudgetFmt ?? '—'} valueSize={26} note="across portfolio" />
        <KpiTile label="Budget Utilised" value={ov?.totals.totalUtilisedFmt ?? '—'} valueSize={26} note={ov ? `${ov.totals.utilisedPct}% of budget · ${ov.filters.fyLabel}` : ''} noteColor={ov && ov.totals.utilisedPct < 40 ? FF.amber : FF.green} />
        <KpiTile label="Overall Achievement" value={overallKpi?.value ?? '—'} valueSize={28} note="vs annual target" />
      </KpiGrid>

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-5">
        <SectionCard title="Combined Growth — Plan vs Actual">
          <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 18 }}>
            Cumulative % of combined annual target, month on month
          </div>
          <PlanVsActualChart data={chart} />
        </SectionCard>

        <SectionCard title="Portfolio Health">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {health.map(h => {
              const c = ffStatusColors(h.key)
              return (
                <div key={h.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${FF.borderFaint}` }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: FF.tealDark }}>{h.label}</span>
                  <StatusBadge bg={c.bg} fg={c.fg} label={`${h.count} projects`} shape="pill" size="sm" />
                </div>
              )
            })}
          </div>
        </SectionCard>
      </div>

      {ov && (
        <SectionCard title="Footprint" titleRight={<span style={{ fontSize: 11, color: FF.textFaint }}><MapPin className="inline w-3 h-3 mr-1" />cumulative reach</span>}>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <Stat label="Districts" value={ov.footprint.districts} />
            <Stat label="Blocks" value={ov.footprint.blocks} />
            <Stat label="Panchayats" value={ov.footprint.panchayats} />
            <Stat label="Villages" value={ov.footprint.villages} />
            <Stat label="Direct Beneficiaries" value={ov.footprint.directBeneficiaries.toLocaleString('en-IN')} accent />
            <Stat label="Institutional Partners" value={ov.footprint.institutionalPartnerships.value} note={ov.footprint.institutionalPartnerships.note} />
            <Stat label="Waterbodies" value={ov.footprint.waterbodies.value} note={ov.footprint.waterbodies.note} />
          </div>
        </SectionCard>
      )}

      {ov && (
        <SectionCard title="Digital Footprint">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {ov.digitalFootprint.map(m => <MetricCell key={m.key} m={m} />)}
          </div>
        </SectionCard>
      )}

      {ov && (
        <SectionCard title="Impact Indicators" titleRight={<span style={{ fontSize: 11, color: FF.textFaint }}>{ov.impact.filter(m => m.available).length}/{ov.impact.length} tracked</span>}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {ov.impact.map(m => <MetricCell key={m.key} m={m} />)}
          </div>
        </SectionCard>
      )}

      {/* System drops (funnel) */}
      {ov && ov.funnel.length > 0 && (
        <SectionCard title="System Drops — Beneficiary → Outcome Funnel">
          <div style={{ fontSize: 12, color: FF.textMuted, marginTop: -8, marginBottom: 18 }}>
            How many registered beneficiaries carry through to each outcome stage. The biggest step-to-step fall is where the system is leaking.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {ov.funnel.map((s, i) => {
              const worst = ov.funnel.slice(1).reduce((a, b) => (b.dropFromPrev > a.dropFromPrev ? b : a), { dropFromPrev: -1 } as FunnelStage)
              const isWorst = i > 0 && s.dropFromPrev === worst.dropFromPrev && s.dropFromPrev >= 40
              return (
                <div key={s.key}>
                  <div className="flex items-center justify-between mb-1" style={{ fontSize: 12.5 }}>
                    <span style={{ color: FF.tealDark, fontWeight: 500 }}>{s.label}</span>
                    <span style={{ color: FF.textMuted }}>
                      {s.count.toLocaleString('en-IN')} · {s.pctOfStart}% of registered
                      {i > 0 && s.dropFromPrev > 0 && (
                        <span style={{ color: isWorst ? FF.red : FF.amber, marginLeft: 8 }}>
                          <TrendingDown className="inline w-3 h-3 mr-0.5" />−{s.dropFromPrev}%
                        </span>
                      )}
                    </span>
                  </div>
                  <ProgressBar pct={s.pctOfStart} color={isWorst ? FF.red : FF.tealDark} height={10} />
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}

      {ov && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <SectionCard title="Barriers Detected">
            {ov.barriers.length === 0 ? (
              <div style={{ fontSize: 13, color: FF.textMuted }}>No barriers detected for {ov.filters.fyLabel}.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {ov.barriers.map((b, i) => {
                  const c = ffStatusColors(b.severity)
                  return (
                    <div key={i} style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 10, background: c.bg }}>
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: c.fg }} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: c.fg }}>{b.title}</div>
                        <div style={{ fontSize: 12.5, color: FF.tealText, marginTop: 2 }}>{b.detail}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Recommended Next Steps">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {ov.nextSteps.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, background: FF.purple, color: '#fff', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ fontSize: 13, color: FF.tealText, lineHeight: 1.5 }}>{s}</span>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      )}

      <SectionCard title="Per-Project Comparison" noPadding>
        <div className="hidden md:block" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 780 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.1fr 110px 1fr 1fr 100px', gap: 12, padding: '10px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}` }}>
              <div>Project</div><div>Program Partner</div><div>Budget</div><div>Budget Used</div><div>Target Achieved</div><div>Health</div>
            </div>
            {(ov?.projects || []).map(p => {
              const ap = apByKey.get(p.project_key)
              const healthKey = (ap?.health || 'amber') as FFStatus
              const c = ffStatusColors(healthKey)
              return (
                <div
                  key={p.project_key}
                  onClick={() => onOpenProject(p.project_key)}
                  style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.1fr 110px 1fr 1fr 100px', gap: 12, alignItems: 'center', padding: '14px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13, cursor: 'pointer' }}
                >
                  <div style={{ color: FF.tealDark, fontWeight: 500 }}>{p.name}</div>
                  <div style={{ color: FF.textMuted }}>{p.programPartner}</div>
                  <div style={{ color: FF.textMuted }}>{p.budgetFmt}</div>
                  <div>
                    <ProgressBar pct={p.utilisedPct} color={FF.purple} />
                    <div style={{ fontSize: 11, color: FF.textMuted, marginTop: 3 }}>{p.utilisedPct}%</div>
                  </div>
                  <div>
                    <ProgressBar pct={ap?.target ?? 0} color={FF.tealDark} />
                    <div style={{ fontSize: 11, color: FF.textMuted, marginTop: 3 }}>{ap?.target ?? 0}%</div>
                  </div>
                  <div><StatusBadge bg={c.bg} fg={c.fg} label={healthKey === 'green' ? 'On Track' : healthKey === 'amber' ? 'At Risk' : 'Critical'} /></div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
          {(ov?.projects || []).map(p => {
            const ap = apByKey.get(p.project_key)
            const healthKey = (ap?.health || 'amber') as FFStatus
            const c = ffStatusColors(healthKey)
            return (
              <div key={p.project_key} onClick={() => onOpenProject(p.project_key)} className="p-4" style={{ cursor: 'pointer' }}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{p.name}</div>
                  <StatusBadge bg={c.bg} fg={c.fg} label={healthKey === 'green' ? 'On Track' : healthKey === 'amber' ? 'At Risk' : 'Critical'} />
                </div>
                <div className="text-xs mb-2" style={{ color: FF.textMuted }}>{p.programPartner} · Budget: {p.budgetFmt}</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between text-[11px] mb-1" style={{ color: FF.textMuted }}>
                      <span>Budget Used</span><span>{p.utilisedPct}%</span>
                    </div>
                    <ProgressBar pct={p.utilisedPct} color={FF.purple} />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] mb-1" style={{ color: FF.textMuted }}>
                      <span>Target Achieved</span><span>{ap?.target ?? 0}%</span>
                    </div>
                    <ProgressBar pct={ap?.target ?? 0} color={FF.tealDark} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>
    </div>
  )
}

function Stat({ label, value, note, accent }: { label: string; value: string | number | null; note?: string; accent?: boolean }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: accent ? FF.bg : FF.bgWarm, border: `1px solid ${FF.borderFaint}` }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: accent ? FF.purple : FF.tealDark }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11.5, color: FF.textMuted, marginTop: 2 }}>{label}</div>
      {note && <div style={{ fontSize: 10.5, color: FF.textFaint, marginTop: 1 }}>{note}</div>}
    </div>
  )
}

function MetricCell({ m }: { m: ImpactMetric }) {
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: FF.bgWarm, border: `1px solid ${FF.borderFaint}`, opacity: m.available ? 1 : 0.6 }}>
      {m.available ? (
        <div style={{ fontSize: 20, fontWeight: 600, color: FF.tealDark }}>{m.value}</div>
      ) : (
        <div style={{ fontSize: 12.5, fontWeight: 500, color: FF.textFaint, fontStyle: 'italic', padding: '4px 0' }}>Not tracked yet</div>
      )}
      <div style={{ fontSize: 11.5, color: FF.textMuted, marginTop: 2 }}>{m.label}</div>
      {m.note && m.available && <div style={{ fontSize: 10.5, color: FF.textFaint, marginTop: 1 }}>{m.note}</div>}
    </div>
  )
}
