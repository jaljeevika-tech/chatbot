import type { OrgMetadata, PlanInfo } from '../../../types/org'
import type { AccessState } from './ui'

export type { PlanInfo }

/** Row from GET /api/superadmin/orgs (metadata has secrets masked). */
export interface OrgRow {
  id: string
  slug: string
  name: string
  metadata: Partial<OrgMetadata> & Record<string, unknown>
  created_at: string | null
  subscription_status: string | null
  subscription_expires_at: string | null
  billing_email: string | null
  suspended_reason: string | null
  plan_id: string | null
  plan_name: string | null
  plan_slug: string | null
  ai_enabled: boolean | null
  max_users: number | null
  user_count: number | string
  access_state: AccessState
}

export interface PlatformStats {
  orgs: {
    total_orgs: number | string; active_orgs: number | string; trialing_orgs: number | string
    expired_orgs: number | string; suspended_orgs: number | string; inactive_orgs: number | string
  }
  plans: { plan_name: string; slug: string; org_count: number | string }[]
  users: { total_users: number | string }
}

export interface OrgUser {
  id: string
  name: string
  phone: string
  role: string
  has_password: boolean
  email?: string | null
  created_at?: string
}
