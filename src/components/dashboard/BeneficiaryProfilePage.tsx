// Beneficiary Profile tab: rosters for the three registered categories (Indirect
// Beneficiary is an MIS by-product, so it has no tab). Each row opens the full
// record plus its linked MIS records via GET /api/beneficiary-profile/:uid.

import { useState } from 'react'
import { FF } from '../../theme/colors'
import { TabPill } from '../ui/TabPill'
import { BeneficiaryRegistrationDashboardPage } from './BeneficiaryRegistrationDashboardPage'
import { CATEGORIES, type CategoryKey, type CardField, type RosterRow } from './beneficiary-profile/helpers'
import { BeneficiaryDetailOverlay } from './beneficiary-profile/BeneficiaryDetailOverlay'
import { CategoryRoster } from './beneficiary-profile/CategoryRoster'
import { BeneficiaryIdCardModal, BulkIdCardModal } from './beneficiary-profile/IdCards'

// Re-exported for BeneficiaryPublicProfilePage (the QR landing page).
export { useBeneficiaryProfile, downloadBeneficiaryProfilePdf, beneficiaryDisplayName } from './beneficiary-profile/profileApi'
export { BeneficiaryProfileDetail } from './beneficiary-profile/BeneficiaryProfileDetail'

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
