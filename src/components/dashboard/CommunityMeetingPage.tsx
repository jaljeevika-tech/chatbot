// MIS > Community Meeting: like CampaignPage.tsx, not linked to beneficiaries; one flat list
// over the org-wide `community_meeting` table (056).

import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { useMisList } from '../../hooks/useMisList'
import { MisBulkDeleteBar, MisRowActions, MisSelectAll, useMisRowActions } from './MisDeleteButton'
import { FF } from '../../theme/colors'
import { SectionCard } from '../ui/SectionCard'
import { MisTabDashboard } from './MisTabDashboard'
import { UploadResultBanner, type UploadRowError } from '../ui/UploadResultBanner'
import { UploadCommunityMeetingModal } from './UploadCommunityMeetingModal'

interface Row {
  id: string
  purpose: string
  total_attendees: number | null
  male_count: number | null
  female_count: number | null
  children_count: number | null
  meeting_date: string | null
  place: string | null
  created_at: string
}
interface Kpis {
  total: number; totalAttendees: number; totalMale: number; totalFemale: number; totalChildren: number
}
interface PurposeBreakdown { label: string; total: number; attendees: number }
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Kpis
  purposeBreakdown: PurposeBreakdown[]
}

const EMPTY: Data = {
  rows: [], totalRows: 0, page: 0, pageSize: 50,
  kpis: { total: 0, totalAttendees: 0, totalMale: 0, totalFemale: 0, totalChildren: 0 },
  purposeBreakdown: [],
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function CommunityMeetingPage({ projectKey }: { projectKey: string }) {
  const [showUpload, setShowUpload] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ saved: number; errors: UploadRowError[] } | null>(null)

  const { data, loading, error, search, setSearch, page, setPage, reload } =
    useMisList<Data>('/api/community-meeting', { project_key: projectKey }, EMPTY)
  const rowActions = useMisRowActions('community-meeting', data.rows, reload)
  const { isAdmin } = rowActions

  const handleUploaded = (saved: number, errors: UploadRowError[]) => {
    setShowUpload(false)
    setUploadResult({ saved, errors })
    if (!errors.length) setTimeout(() => setUploadResult(null), 5000)
    reload()
  }

  const pageCount = Math.max(1, Math.ceil(data.totalRows / data.pageSize))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search Purpose or Place…"
          className="w-full sm:w-auto sm:min-w-[280px] sm:max-w-[420px] rounded-lg px-3 py-2 text-sm outline-none"
          style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
        />
        <button
          onClick={() => setShowUpload(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white shrink-0"
          style={{ background: FF.purple }}
        >
          <Upload className="w-4 h-4" /> Upload Community Meeting Sheet
        </button>
      </div>

      {uploadResult && (
        <UploadResultBanner
          saved={uploadResult.saved}
          noun="community meeting record"
          errors={uploadResult.errors}
          onDismiss={() => setUploadResult(null)}
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : error ? (
        <div className="rounded-2xl p-6 text-sm text-center" style={{ background: '#FFFFFF', color: '#B0473C', border: `1.5px solid ${FF.border}` }}>{error}</div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No community meeting records yet. Click "Upload Community Meeting Sheet" above to add one.
        </div>
      ) : (
        <>
          <MisTabDashboard
            kpis={[
              { label: 'Total Meetings', value: data.kpis.total },
              { label: 'Total Attendees', value: data.kpis.totalAttendees },
              { label: 'Male', value: data.kpis.totalMale },
              { label: 'Female', value: data.kpis.totalFemale },
              { label: 'Children', value: data.kpis.totalChildren },
            ]}
            breakdownTitle="Top Purposes by Attendance"
            valueLabel="Attendees"
            breakdown={data.purposeBreakdown.map(t => ({ label: t.label, value: t.attendees, sub: `${t.total} meeting${t.total === 1 ? '' : 's'}` }))}
          />

          {isAdmin && <MisBulkDeleteBar a={rowActions} />}

          <SectionCard noPadding>
            {/* md+: grid table; below md the rows render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 900 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `1.4fr 110px 90px 90px 100px 110px 1fr${isAdmin ? ' 64px' : ''}`,
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>Purpose</div><div>Attendees</div><div>Male</div><div>Female</div>
                  <div>Children</div><div>Date</div><div>Place</div>
                  {isAdmin && <MisSelectAll a={rowActions} />}
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `1.4fr 110px 90px 90px 100px 110px 1fr${isAdmin ? ' 64px' : ''}`,
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.purpose}</div>
                    <div style={{ color: FF.textMuted }}>{r.total_attendees ?? '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.male_count ?? '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.female_count ?? '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.children_count ?? '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{fmtDate(r.meeting_date)}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.place || '—'}</div>
                    {isAdmin && <MisRowActions a={rowActions} id={r.id} />}
                  </div>
                ))}
              </div>
            </div>

            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {data.rows.map(r => (
                <div key={r.id} className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.purpose}</div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{fmtDate(r.meeting_date)}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Attendees: {r.total_attendees ?? '—'}</div>
                    <div>Place: {r.place || '—'}</div>
                    <div>Male: {r.male_count ?? '—'}</div>
                    <div>Female: {r.female_count ?? '—'}</div>
                    <div>Children: {r.children_count ?? '—'}</div>
                  </div>
                  {isAdmin && <div className="mt-2 flex justify-end"><MisRowActions a={rowActions} id={r.id} /></div>}
                </div>
              ))}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: `1px solid ${FF.borderFaint}` }}>
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                >
                  Previous
                </button>
                <span className="text-xs" style={{ color: FF.textFaint }}>
                  Page {page + 1} of {pageCount} · {data.totalRows} records
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-40"
                  style={{ borderColor: FF.border, color: FF.tealDark }}
                >
                  Next
                </button>
              </div>
            )}
          </SectionCard>
        </>
      )}

      {showUpload && (
        <UploadCommunityMeetingModal
          projectKey={projectKey}
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  )
}
