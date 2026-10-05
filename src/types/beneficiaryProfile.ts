// Types for the Beneficiary Profile page and GET /api/beneficiary-profile/:uid.
// Each registry row has every column the registration form collects, not just the list-view subset.

export type BeneficiaryCategory = 'Individual Beneficiary' | 'Micro-Entrepreneur' | 'Collective'

// An entry of the "Type of Production System" multiselect (067). Livestock uses
// livestock_count; other types use production_quintal. Only the field matching `type` is set.
export interface ProductionSystemEntry {
  type: 'Aquaculture' | 'Agriculture' | 'Livestock' | 'Horticulture'
  production_quintal?: number | null
  livestock_count?: number | null
}

export interface IndividualBeneficiaryProfile {
  id: string
  uid: string
  name: string
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  panchayat: string | null
  village: string | null
  gender: string | null
  age: number | null
  occupation: string | null
  education: string | null
  household_size: number | null
  current_income_inr: number | null
  baseline_income_inr: number | null
  production_type: string | null // legacy single-select — null on every beneficiary registered after 067
  current_production_ton: number | null // legacy — see production_type
  production_systems: ProductionSystemEntry[]
  baseline_production_ton: number | null
  member_of_collective: boolean | null
  collective_name: string | null
  bank_account_no: string | null
  aadhaar_no: string | null
  created_at: string
  [key: string]: unknown // registration form may collect org-specific extra fields
}

export interface MicroEntrepreneurProfile {
  id: string
  uid: string
  name: string
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  panchayat: string | null
  village: string | null
  gender: string | null
  age: number | null
  enterprise_name: string | null
  business_activity: string | null
  year_of_establishment: number | null
  current_revenue_inr: number | null
  baseline_revenue_inr: number | null
  current_employee_count: number | null
  baseline_employee_count: number | null
  production_systems: ProductionSystemEntry[]
  bank_account_no: string | null
  aadhaar_no: string | null
  created_at: string
  [key: string]: unknown
}

export interface CollectiveProfile {
  id: string
  uid: string
  collective_name: string
  collective_type: string | null
  lead_person_name: string | null
  contact_no: string | null
  state: string | null
  district: string | null
  block: string | null
  panchayat: string | null
  village: string | null
  registration_no: string | null
  year_of_formation: number | null
  male_count: number | null
  female_count: number | null
  focus_area: string | null
  current_revenue_inr: number | null
  baseline_revenue_inr: number | null
  production_type: string | null // legacy single-select — null on every collective registered after 068
  current_production_ton: number | null // legacy — see production_type
  production_systems: ProductionSystemEntry[]
  per_capita_income_inr: number | null
  credit_access_inr: number | null
  bank_account_no: string | null
  created_at: string
  [key: string]: unknown
}

export type BeneficiaryMasterProfile = IndividualBeneficiaryProfile | MicroEntrepreneurProfile | CollectiveProfile

// One row shape per MIS category, matching what each category's route selects.
interface MisRowBase {
  id: string
  beneficiary_uid: string
  beneficiary_type: string
  beneficiary_name: string | null
  contact_no: string | null
  place: string | null
  created_at: string
  // project_name falls back to the raw key if the plan was deleted.
  project_key: string
  project_name: string
}
export interface TrainingRow extends MisRowBase { training_topic: string; training_date: string | null }
export interface InputDistributionRow extends MisRowBase { input_distributed: string; distribution_date: string | null }
export interface SchemeAccessRow extends MisRowBase { scheme_name: string; access_date: string | null }
export interface CreditGrantAccessRow extends MisRowBase {
  credit_grant_source: string; credit_grant_type: string | null; entity_name: string | null
  amount: number | null; access_date: string | null
}
export interface BusinessDevelopmentSupportRow extends MisRowBase { support_provided: string; support_date: string | null }
export interface ComplianceSupportRow extends MisRowBase { compliance_support_provided: string; support_date: string | null }
// Exposure Visit has no generic `place` column (see db/migrations/054) —
// "Place of Exposure Visit" is its own visit_place column instead.
export interface ExposureVisitRow extends Omit<MisRowBase, 'place'> { purpose: string; visit_place: string | null; visit_date: string | null }
// Income has no per-record date column — financial_year (a text range like
// "2026-2027") stands in wherever a MisTable needs a "date" to display.
export interface IncomeRow extends MisRowBase { financial_year: string; income_source: string; income_realised: number | null }
// Campaign is an aggregate event with no beneficiary_uid, so it never appears here
// (its row type lives in CampaignPage.tsx).

export interface BeneficiaryMisData {
  training: TrainingRow[]
  income: IncomeRow[]
  inputDistribution: InputDistributionRow[]
  schemeAccess: SchemeAccessRow[]
  creditGrantAccess: CreditGrantAccessRow[]
  businessDevelopmentSupport: BusinessDevelopmentSupportRow[]
  complianceSupport: ComplianceSupportRow[]
  exposureVisit: ExposureVisitRow[]
}

// Many-to-many (beneficiary_project_links); `name` falls back to the raw project_key
// if the plan was deleted.
export interface LinkedProject {
  project_key: string
  name: string
}

// Physical resource registered against this UID via services/resource/ (see
// ResourcePage.tsx). Org-wide, so no project_key.
export interface ResourceUtilityEntry {
  utility: string
  production_kg: number | null
}
export interface ResourceRow {
  id: string
  uid: string
  resource_type: string
  latitude: number | null
  longitude: number | null
  area_acre: number | null
  water_body_type: string | null
  resource_access: string | null
  wetland_structure: string | null
  raft_count: number | null
  resource_utility: ResourceUtilityEntry[]
  created_at: string
}

export interface BeneficiaryProfileResponse {
  uid: string
  type: BeneficiaryCategory | 'Indirect Beneficiary'
  profile: BeneficiaryMasterProfile
  mis: BeneficiaryMisData
  misRecordCount: number
  projects: LinkedProject[]
  resources: ResourceRow[]
}

export interface UpdateBeneficiaryProjectsResponse {
  uid: string
  projects: LinkedProject[]
}

// Same payload as the GET, so callers can replace their state with it directly.
export type UpdateBeneficiaryProfileResponse = BeneficiaryProfileResponse
