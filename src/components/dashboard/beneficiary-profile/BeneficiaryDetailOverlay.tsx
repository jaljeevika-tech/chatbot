import { useState } from 'react'
import { Loader2, X, User, QrCode, Download } from 'lucide-react'
import { useAuthContext } from '../../../context/AuthContext'
import { FF } from '../../../theme/colors'
import { cardFieldsForType } from './helpers'
import { useBeneficiaryProfile, downloadBeneficiaryProfilePdf, beneficiaryDisplayName } from './profileApi'
import { BeneficiaryIdCardModal } from './IdCards'
import { BeneficiaryProfileDetail } from './BeneficiaryProfileDetail'

export function BeneficiaryDetailOverlay({ uid, onClose }: { uid: string; onClose: () => void }) {
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
