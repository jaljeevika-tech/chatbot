import { useEffect, useState } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import { FF } from '../../../theme/colors'
import { SectionCard } from '../../ui/SectionCard'
import { AddInterventionModal, INTERVENTION_CATEGORIES, type InterventionCategoryConfig } from '../AddInterventionModal'
import type {
  BeneficiaryProfileResponse, TrainingRow, IncomeRow, InputDistributionRow, SchemeAccessRow,
  CreditGrantAccessRow, BusinessDevelopmentSupportRow, ComplianceSupportRow, ExposureVisitRow,
} from '../../../types/beneficiaryProfile'
import { inr, READONLY_DETAIL_FIELDS } from './helpers'
import { DetailGrid, EditableDetailGrid } from './DetailGrids'
import { MisTable, ResourceTable, ProjectChips } from './ProfileSections'
import { updateBeneficiaryProfile } from './profileApi'

// Also rendered read-only by BeneficiaryPublicProfilePage (the QR landing page),
// which omits the edit props. `editable` (any editor) only gates adding
// interventions; `canEditProfile` (admins only) gates editing Complete Detail.
export function BeneficiaryProfileDetail({ data, uid, editable, onRecordAdded, canEditProfile, onProfileSaved }: {
  data: BeneficiaryProfileResponse
  uid?: string
  editable?: boolean
  onRecordAdded?: () => void
  canEditProfile?: boolean
  onProfileSaved?: () => void
}) {
  const [addingCategory, setAddingCategory] = useState<InterventionCategoryConfig | null>(null)
  const categoryFor = (apiCategory: string) => INTERVENTION_CATEGORIES.find(c => c.apiCategory === apiCategory)
  const addHandler = (apiCategory: string) => editable && uid ? () => setAddingCategory(categoryFor(apiCategory) || null) : undefined

  const [editingProfile, setEditingProfile] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(data.profile as unknown as Record<string, unknown>) }))
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null)

  // Re-seed on every new profile so a stale edit never carries over.
  useEffect(() => {
    setDraft({ ...(data.profile as unknown as Record<string, unknown>) })
  }, [data.profile])

  const startEdit = () => {
    setDraft({ ...(data.profile as unknown as Record<string, unknown>) })
    setProfileSaveError(null)
    setEditingProfile(true)
  }
  const cancelEdit = () => {
    setDraft({ ...(data.profile as unknown as Record<string, unknown>) })
    setProfileSaveError(null)
    setEditingProfile(false)
  }
  const saveProfile = async () => {
    if (!uid) return
    setSavingProfile(true)
    setProfileSaveError(null)
    try {
      // draft is a full copy of the profile; drop read-only fields before sending.
      const updates = { ...draft }
      for (const key of READONLY_DETAIL_FIELDS) delete updates[key]
      await updateBeneficiaryProfile(uid, updates)
      setEditingProfile(false)
      onProfileSaved?.()
    } catch (e: any) {
      setProfileSaveError(e.message || 'Could not save changes')
    } finally {
      setSavingProfile(false)
    }
  }

  return (
    <>
      <SectionCard
        title="Complete Detail"
        titleRight={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: FF.textFaint }}>{data.misRecordCount} Intervention record{data.misRecordCount === 1 ? '' : 's'}</span>
            {canEditProfile && uid && !editingProfile && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 rounded-lg text-xs font-semibold shrink-0"
                style={{ padding: '6px 10px', background: FF.purple, color: '#fff' }}
              >
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            )}
            {editingProfile && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={cancelEdit}
                  disabled={savingProfile}
                  className="rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ padding: '6px 10px', background: 'transparent', border: `1px solid ${FF.borderSoft}`, color: FF.textMuted }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveProfile}
                  disabled={savingProfile}
                  className="flex items-center gap-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ padding: '6px 10px', background: FF.purple, color: '#fff' }}
                >
                  {savingProfile && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
                </button>
              </div>
            )}
          </div>
        }
      >
        {profileSaveError && (
          <div className="rounded-xl p-2.5 text-xs" style={{ marginBottom: 12, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}>{profileSaveError}</div>
        )}
        {editingProfile
          ? <EditableDetailGrid record={data.profile as unknown as Record<string, unknown>} draft={draft} onChange={(key, value) => setDraft(d => ({ ...d, [key]: value }))} />
          : <DetailGrid record={data.profile as unknown as Record<string, unknown>} />}
      </SectionCard>

      <ProjectChips projects={data.projects} />

      <div>
        <div style={{ fontFamily: "'Newsreader',serif", fontSize: 16, fontWeight: 600, color: FF.tealDark, margin: '4px 0 12px' }}>Resources</div>
        <ResourceTable rows={data.resources} />
      </div>

      <div>
        <div style={{ fontFamily: "'Newsreader',serif", fontSize: 16, fontWeight: 600, color: FF.tealDark, margin: '4px 0 12px' }}>Intervention Recorded Data</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <MisTable<TrainingRow> title="Training" rows={data.mis.training} primaryLabel="Topic" primaryOf={r => r.training_topic} dateOf={r => r.training_date} onAdd={addHandler('training')} />
          <MisTable<InputDistributionRow> title="Input Distribution" rows={data.mis.inputDistribution} primaryLabel="Input Distributed" primaryOf={r => r.quantity != null ? `${r.input_distributed} — ${Number(r.quantity)}${r.unit ? ' ' + r.unit : ''}` : r.input_distributed} dateOf={r => r.distribution_date} onAdd={addHandler('inputDistribution')} />
          <MisTable<SchemeAccessRow> title="Scheme Access" rows={data.mis.schemeAccess} primaryLabel="Scheme" primaryOf={r => r.scheme_name} dateOf={r => r.access_date} onAdd={addHandler('schemeAccess')} />
          <MisTable<CreditGrantAccessRow>
            title="Credit/Grant Access" rows={data.mis.creditGrantAccess} primaryLabel="Source" primaryOf={r => r.credit_grant_source}
            dateOf={r => r.access_date} extra={{ label: 'Amount', of: r => inr(r.amount) }} onAdd={addHandler('creditGrantAccess')}
          />
          <MisTable<BusinessDevelopmentSupportRow> title="Business Development Support" rows={data.mis.businessDevelopmentSupport} primaryLabel="Support Provided" primaryOf={r => r.support_provided} dateOf={r => r.support_date} onAdd={addHandler('businessDevelopmentSupport')} />
          <MisTable<ComplianceSupportRow> title="Compliance Support" rows={data.mis.complianceSupport} primaryLabel="Support Provided" primaryOf={r => r.compliance_support_provided} dateOf={r => r.support_date} onAdd={addHandler('complianceSupport')} />
          <MisTable<ExposureVisitRow>
            title="Exposure Visit" rows={data.mis.exposureVisit} primaryLabel="Purpose" primaryOf={r => r.purpose}
            dateOf={r => r.visit_date} placeOf={r => r.visit_place} onAdd={addHandler('exposureVisit')}
          />
          <MisTable<IncomeRow>
            title="Income" rows={data.mis.income} primaryLabel="Source" primaryOf={r => r.income_source}
            dateOf={r => r.financial_year} extra={{ label: 'Amount', of: r => inr(r.income_realised) }} onAdd={addHandler('income')}
          />
        </div>
      </div>

      {addingCategory && uid && (
        <AddInterventionModal
          uid={uid}
          category={addingCategory}
          onClose={() => setAddingCategory(null)}
          onSaved={() => { setAddingCategory(null); onRecordAdded?.() }}
        />
      )}
    </>
  )
}
