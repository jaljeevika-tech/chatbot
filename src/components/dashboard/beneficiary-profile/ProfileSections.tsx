import { PlusCircle } from 'lucide-react'
import { FF, projectDot, projectBadge } from '../../../theme/colors'
import { SectionCard } from '../../ui/SectionCard'
import type { ResourceRow, LinkedProject } from '../../../types/beneficiaryProfile'
import { formatFieldValue } from './helpers'

// Generic MIS record table. The Project column is per row (the project open
// when the sheet was uploaded), so it can differ from the beneficiary's
// enrolled projects.
export function MisTable<T extends { id: string; created_at: string; project_name: string }>({
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

export function ResourceTable({ rows }: { rows: ResourceRow[] }) {
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
export function ProjectChips({ projects }: { projects: LinkedProject[] }) {
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
