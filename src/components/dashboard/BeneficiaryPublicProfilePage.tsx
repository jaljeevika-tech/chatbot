// Landing page for the beneficiary QR code at the plain path `/beneficiary/:uid`,
// independent of DashboardPage's tabs and permissions: scan, log in if needed, see the
// profile. Reuses BeneficiaryProfilePage's fetch hook and detail component.

import { useState } from 'react'
import { Loader2, ArrowLeft, Download } from 'lucide-react'
import { useOrg } from '../../context/OrgContext'
import { FF } from '../../theme/colors'
import {
  useBeneficiaryProfile, beneficiaryDisplayName, BeneficiaryProfileDetail, downloadBeneficiaryProfilePdf,
} from './BeneficiaryProfilePage'

export function BeneficiaryPublicProfilePage({ uid }: { uid: string }) {
  const { org } = useOrg()
  const { loading, error, data } = useBeneficiaryProfile(uid)
  const displayName = beneficiaryDisplayName(data, uid)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  const orgName = org?.branding.org_name || 'FieldFlow'
  const logoUrl = org?.branding.logo_url || '/logo.png'

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
    <div style={{ minHeight: '100vh', background: FF.bg, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div style={{ position: 'sticky', top: 0, background: FF.tealDark, zIndex: 1 }}>
        <div style={{ maxWidth: 920, margin: '0 auto', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
              <img src={logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "'Newsreader',serif", fontSize: 17, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
              <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.65)', fontFamily: 'monospace' }}>{uid} {data ? `· ${data.type}` : ''}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleDownloadPdf}
              disabled={downloadingPdf}
              title="Download profile as PDF"
              className="flex items-center gap-1.5 rounded-lg text-xs font-semibold"
              style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.12)', color: '#fff' }}
            >
              {downloadingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} PDF
            </button>
            <button
              onClick={() => { window.location.href = '/' }}
              title="Back to dashboard"
              className="flex items-center gap-1.5 rounded-lg text-xs font-semibold"
              style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.12)', color: '#fff' }}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Dashboard
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 920, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {pdfError && (
          <div className="rounded-xl p-3 text-xs" style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}>{pdfError}</div>
        )}
        <p style={{ fontSize: 11, color: FF.textFaint, margin: 0 }}>{orgName} · Beneficiary Profile</p>

        {loading && (
          <div className="flex items-center justify-center py-20" style={{ color: FF.textFaint }}><Loader2 className="w-6 h-6 animate-spin" /></div>
        )}
        {error && !loading && (
          <div className="rounded-2xl border-2 border-dashed p-8 text-center" style={{ borderColor: FF.red, color: FF.red }}>{error}</div>
        )}
        {data && !loading && !error && <BeneficiaryProfileDetail data={data} />}
      </div>
    </div>
  )
}
