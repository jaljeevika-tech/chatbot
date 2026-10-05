import { useEffect, useRef, useState } from 'react'
import { Loader2, X, Download, Printer } from 'lucide-react'
import { saveAs } from 'file-saver'
import { apiFetch } from '../../../utils/apiFetch'
import { useOrg } from '../../../context/OrgContext'
import { FF } from '../../../theme/colors'
import type { CardField, RosterRow } from './helpers'

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

export function BeneficiaryIdCardModal({ row, uid, fields, onClose }: {
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
export function BulkIdCardModal({ rows, fields, onClose }: {
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
