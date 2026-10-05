// MIS > Community Meeting: like CampaignPage.tsx, not linked to beneficiaries; one flat list
// over the org-wide `community_meeting` table (056).

import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { useMisList } from '../../hooks/useMisList'
import { FF } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
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
          <KpiGrid cols={5}>
            <KpiTile label="Total Meetings" value={data.kpis.total} />
            <KpiTile label="Total Attendees" value={data.kpis.totalAttendees} />
            <KpiTile label="Male" value={data.kpis.totalMale} />
            <KpiTile label="Female" value={data.kpis.totalFemale} />
            <KpiTile label="Children" value={data.kpis.totalChildren} />
          </KpiGrid>

          {data.purposeBreakdown.length > 0 && (
            <SectionCard title="Top Purposes by Attendance">
              <div className="flex flex-col gap-2.5">
                {(() => {
                  const maxVal = Math.max(...data.purposeBreakdown.map(t => t.attendees), 1)
                  return data.purposeBreakdown.map(t => (
                    <div key={t.label}>
                      <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                        <span>{t.label}</span>
                        <span style={{ fontWeight: 600, color: FF.tealDark }}>{t.attendees} attendees · {t.total} meeting{t.total === 1 ? '' : 's'}</span>
                      </div>
                      <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
                        <div style={{ height: 8, width: `${Math.max((t.attendees / maxVal) * 100, 3)}%`, background: FF.purple, borderRadius: 999, transition: 'width .3s' }} />
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </SectionCard>
          )}

          <SectionCard noPadding>
            {/* md+: grid table; below md the rows render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 900 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.4fr 110px 90px 90px 100px 110px 1fr',
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>Purpose</div><div>Attendees</div><div>Male</div><div>Female</div>
                  <div>Children</div><div>Date</div><div>Place</div>
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.4fr 110px 90px 90px 100px 110px 1fr',
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
