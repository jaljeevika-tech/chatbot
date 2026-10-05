// MIS > Credit/Grant Access: like TrainingPage.tsx, but the table (050) has source, type,
// entity and amount, so there's a Total Amount tile and extra columns.

import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { useMisList } from '../../hooks/useMisList'
import { FF } from '../../theme/colors'
import { KpiTile } from '../ui/KpiTile'
import { KpiGrid } from '../ui/KpiGrid'
import { SectionCard } from '../ui/SectionCard'
import { TabPill } from '../ui/TabPill'
import { UploadResultBanner, type UploadRowError, type UploadRowWarning } from '../ui/UploadResultBanner'
import { UploadCreditGrantAccessModal } from './UploadCreditGrantAccessModal'

type BenfSubTab = 'individual' | 'entrepreneur' | 'collective' | 'indirect'

const SUB_TABS: { key: BenfSubTab; label: string; dbType: string }[] = [
  { key: 'individual',   label: 'Individual',         dbType: 'Individual Beneficiary' },
  { key: 'entrepreneur', label: 'Micro-Entrepreneurs', dbType: 'Micro-Entrepreneur' },
  { key: 'collective',   label: 'Collective',          dbType: 'Collective' },
  { key: 'indirect',     label: 'Indirect',            dbType: 'Indirect Beneficiary' },
]

interface Row {
  id: string
  beneficiary_uid: string
  beneficiary_type: string
  beneficiary_name: string | null
  contact_no: string | null
  credit_grant_source: string
  credit_grant_type: string | null
  entity_name: string | null
  amount: number | null
  access_date: string | null
  place: string | null
  created_at: string
}
interface Kpis {
  total: number; individual: number; entrepreneur: number; collective: number
  indirect: number; uniqueBeneficiaries: number; totalAmount: number
}
interface SourceBreakdown { label: string; total: number; totalAmount: number }
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Kpis
  sourceBreakdown: SourceBreakdown[]
}

const EMPTY: Data = {
  rows: [], totalRows: 0, page: 0, pageSize: 50,
  kpis: { total: 0, individual: 0, entrepreneur: 0, collective: 0, indirect: 0, uniqueBeneficiaries: 0, totalAmount: 0 },
  sourceBreakdown: [],
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

export function CreditGrantAccessPage({ projectKey }: { projectKey: string }) {
  const [subTab, setSubTab] = useState<BenfSubTab>('individual')
  const [showUpload, setShowUpload] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ saved: number; errors: UploadRowError[]; duplicates: number; warnings: UploadRowWarning[] } | null>(null)

  const dbType = SUB_TABS.find(t => t.key === subTab)!.dbType

  const { data, loading, error, search, setSearch, page, setPage, reload } =
    useMisList<Data>('/api/credit-grant-access', { project_key: projectKey, beneficiary_type: dbType }, EMPTY)

  const handleUploaded = (saved: number, errors: UploadRowError[], duplicates: number, warnings: UploadRowWarning[]) => {
    setShowUpload(false)
    setUploadResult({ saved, errors, duplicates, warnings })
    if (!errors.length) setTimeout(() => setUploadResult(null), 5000)
    reload()
  }

  const pageCount = Math.max(1, Math.ceil(data.totalRows / data.pageSize))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <TabPill tabs={SUB_TABS} active={subTab} onChange={setSubTab} size="xs" />
        <button
          onClick={() => setShowUpload(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white shrink-0"
          style={{ background: FF.purple }}
        >
          <Upload className="w-4 h-4" /> Upload Credit/Grant Access Sheet
        </button>
      </div>

      {uploadResult && (
        <UploadResultBanner
          saved={uploadResult.saved}
          noun="credit/grant record"
          errors={uploadResult.errors}
          duplicates={uploadResult.duplicates}
          warnings={uploadResult.warnings}
          onDismiss={() => setUploadResult(null)}
        />
      )}

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search Beneficiary UID, Name, Source or Entity…"
        className="rounded-lg px-3 py-2 text-sm outline-none"
        style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, minWidth: 280, maxWidth: 420 }}
      />

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : error ? (
        <div className="rounded-2xl p-6 text-sm text-center" style={{ background: '#FFFFFF', color: '#B0473C', border: `1.5px solid ${FF.border}` }}>{error}</div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No credit/grant access records yet for {SUB_TABS.find(t => t.key === subTab)!.label.toLowerCase()} beneficiaries.
          Click "Upload Credit/Grant Access Sheet" above to add one.
        </div>
      ) : (
        <>
          <KpiGrid cols={6}>
            <KpiTile label="Total (this tab)" value={data.kpis.total} />
            <KpiTile label="Total Amount" value={inr(data.kpis.totalAmount)} />
            <KpiTile label="Unique Beneficiaries" value={data.kpis.uniqueBeneficiaries} />
            <KpiTile label="Individual" value={data.kpis.individual} />
            <KpiTile label="Micro-Entrepreneurs" value={data.kpis.entrepreneur} />
            <KpiTile label="Collective" value={data.kpis.collective} />
          </KpiGrid>

          {data.sourceBreakdown.length > 0 && (
            <SectionCard title="Top Sources by Amount">
              <div className="flex flex-col gap-2.5">
                {(() => {
                  const maxVal = Math.max(...data.sourceBreakdown.map(t => t.totalAmount), 1)
                  return data.sourceBreakdown.map(t => (
                    <div key={t.label}>
                      <div className="flex justify-between text-xs mb-1" style={{ color: FF.textMuted }}>
                        <span>{t.label}</span>
                        <span style={{ fontWeight: 600, color: FF.tealDark }}>{inr(t.totalAmount)} · {t.total} record{t.total === 1 ? '' : 's'}</span>
                      </div>
                      <div style={{ height: 8, background: FF.borderSoft, borderRadius: 999 }}>
                        <div style={{ height: 8, width: `${Math.max((t.totalAmount / maxVal) * 100, 3)}%`, background: FF.purple, borderRadius: 999, transition: 'width .3s' }} />
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
              <div style={{ minWidth: 1200 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 1fr 130px 1.1fr 100px 1.1fr 110px 100px 1fr',
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>Beneficiary UID</div><div>Name</div><div>Contact No.</div>
                  <div>Source</div><div>Type</div><div>Entity</div><div>Amount</div><div>Date</div><div>Place</div>
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr 130px 1.1fr 100px 1.1fr 110px 100px 1fr',
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.beneficiary_uid}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.beneficiary_name || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.contact_no || '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.credit_grant_source}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.credit_grant_type || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.entity_name || '—'}</div>
                    <div style={{ color: FF.textMuted }}>{r.amount != null ? inr(r.amount) : '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{fmtDate(r.access_date)}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.place || '—'}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="md:hidden divide-y" style={{ borderColor: FF.borderFaint }}>
              {data.rows.map(r => (
                <div key={r.id} className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.beneficiary_uid}</div>
                      <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.beneficiary_name || '—'}</div>
                    </div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{fmtDate(r.access_date)}</div>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 13, fontWeight: 500 }}>{r.credit_grant_source}</div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Contact: {r.contact_no || '—'}</div>
                    <div>Type: {r.credit_grant_type || '—'}</div>
                    <div>Entity: {r.entity_name || '—'}</div>
                    <div>Amount: {r.amount != null ? inr(r.amount) : '—'}</div>
                    <div>Place: {r.place || '—'}</div>
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
        <UploadCreditGrantAccessModal
          projectKey={projectKey}
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  )
}
