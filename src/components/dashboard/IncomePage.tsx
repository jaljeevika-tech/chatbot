// MIS > Income: one Excel upload feeds the org-wide `income` table (071). UIDs resolve
// server-side to a beneficiary (blank → auto-created Indirect Beneficiary); the sub-tabs
// filter by beneficiary_type.

import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { useMisList } from '../../hooks/useMisList'
import { MisBulkDeleteBar, MisRowActions, MisSelectAll, useMisRowActions } from './MisDeleteButton'
import { FF } from '../../theme/colors'
import { SectionCard } from '../ui/SectionCard'
import { MisTabDashboard } from './MisTabDashboard'
import { TabPill } from '../ui/TabPill'
import { UploadResultBanner, type UploadRowError, type UploadRowWarning } from '../ui/UploadResultBanner'
import { UploadIncomeModal } from './UploadIncomeModal'

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
  financial_year: string
  income_source: string
  income_realised: number | null
  place: string | null
  created_at: string
}
interface Kpis {
  total: number; individual: number; entrepreneur: number; collective: number
  indirect: number; uniqueBeneficiaries: number; totalIncome: number
}
interface SourceItem { label: string; total: number; amount: number }
interface Data {
  rows: Row[]
  totalRows: number
  page: number
  pageSize: number
  kpis: Kpis
  sourceBreakdown: SourceItem[]
}

const EMPTY: Data = {
  rows: [], totalRows: 0, page: 0, pageSize: 50,
  kpis: { total: 0, individual: 0, entrepreneur: 0, collective: 0, indirect: 0, uniqueBeneficiaries: 0, totalIncome: 0 },
  sourceBreakdown: [],
}

function fmtInr(v: number | null): string {
  if (v == null) return '—'
  return `₹${v.toLocaleString('en-IN')}`
}

export function IncomePage({ projectKey }: { projectKey: string }) {
  const [subTab, setSubTab] = useState<BenfSubTab>('individual')
  const [showUpload, setShowUpload] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ saved: number; errors: UploadRowError[]; duplicates: number; warnings: UploadRowWarning[] } | null>(null)

  const dbType = SUB_TABS.find(t => t.key === subTab)!.dbType

  const { data, loading, error, search, setSearch, page, setPage, reload } =
    useMisList<Data>('/api/income', { project_key: projectKey, beneficiary_type: dbType }, EMPTY)
  const rowActions = useMisRowActions('income', data.rows, reload)
  const { isAdmin } = rowActions

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
          <Upload className="w-4 h-4" /> Upload Income Sheet
        </button>
      </div>

      {uploadResult && (
        <UploadResultBanner
          saved={uploadResult.saved}
          noun="income record"
          errors={uploadResult.errors}
          duplicates={uploadResult.duplicates}
          warnings={uploadResult.warnings}
          onDismiss={() => setUploadResult(null)}
        />
      )}

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search Beneficiary UID, Name or Source…"
        className="rounded-lg px-3 py-2 text-sm outline-none"
        style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark, minWidth: 280, maxWidth: 420 }}
      />

      {loading ? (
        <div className="flex items-center justify-center py-16" style={{ color: FF.textFaint }}><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : error ? (
        <div className="rounded-2xl p-6 text-sm text-center" style={{ background: '#FFFFFF', color: '#B0473C', border: `1.5px solid ${FF.border}` }}>{error}</div>
      ) : data.kpis.total === 0 ? (
        <div className="rounded-2xl border-2 border-dashed p-10 text-center" style={{ borderColor: FF.border, background: '#FFFFFF', color: FF.textFaint }}>
          No income records yet for {SUB_TABS.find(t => t.key === subTab)!.label.toLowerCase()} beneficiaries.
          Click "Upload Income Sheet" above to add one.
        </div>
      ) : (
        <>
          <MisTabDashboard
            kpis={[
              { label: 'Total (this tab)', value: data.kpis.total },
              { label: 'Unique Beneficiaries', value: data.kpis.uniqueBeneficiaries },
              { label: 'Income Realised', value: fmtInr(data.kpis.totalIncome) },
              { label: 'Individual', value: data.kpis.individual },
              { label: 'Micro-Entrepreneurs', value: data.kpis.entrepreneur },
            ]}
            breakdownTitle="Income by Source"
            valueLabel="Income"
            formatValue={fmtInr}
            breakdown={data.sourceBreakdown.map(s => ({ label: s.label, value: s.amount, sub: `${s.total} record${s.total === 1 ? '' : 's'}` }))}
          />

          {isAdmin && <MisBulkDeleteBar a={rowActions} />}

          <SectionCard noPadding>
            {/* md+: grid table; below md the rows render as cards instead */}
            <div className="hidden md:block" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 960 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `120px 1fr 110px 1fr 130px 1fr${isAdmin ? ' 64px' : ''}`,
                    gap: 12, padding: '14px 22px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
                    color: FF.textFaint, borderBottom: `1px solid ${FF.borderSoft}`,
                  }}
                >
                  <div>Beneficiary UID</div><div>Name</div><div>Financial Year</div>
                  <div>Source</div><div>Income (INR)</div><div>Place</div>
                  {isAdmin && <MisSelectAll a={rowActions} />}
                </div>
                {data.rows.map(r => (
                  <div
                    key={r.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `120px 1fr 110px 1fr 130px 1fr${isAdmin ? ' 64px' : ''}`,
                      gap: 12, alignItems: 'center', padding: '13px 22px', borderBottom: `1px solid ${FF.borderFaint}`, fontSize: 13,
                    }}
                  >
                    <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.beneficiary_uid}</div>
                    <div style={{ color: FF.tealDark, fontWeight: 500 }}>{r.beneficiary_name || '—'}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{r.financial_year}</div>
                    <div style={{ color: FF.textMuted }}>{r.income_source}</div>
                    <div style={{ color: FF.textMuted, fontSize: 12 }}>{fmtInr(r.income_realised)}</div>
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
                    <div className="min-w-0">
                      <div style={{ color: FF.tealDark, fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{r.beneficiary_uid}</div>
                      <div className="mt-0.5" style={{ color: FF.tealDark, fontWeight: 500, fontSize: 14 }}>{r.beneficiary_name || '—'}</div>
                    </div>
                    <div className="text-right shrink-0" style={{ color: FF.textMuted, fontSize: 12 }}>{r.financial_year}</div>
                  </div>
                  <div style={{ color: FF.tealText, fontSize: 13, fontWeight: 500 }}>{r.income_source} — {fmtInr(r.income_realised)}</div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: 12, color: FF.textMuted }}>
                    <div>Place: {r.place || '—'}</div>
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
        <UploadIncomeModal
          projectKey={projectKey}
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  )
}
