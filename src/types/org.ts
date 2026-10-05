export interface OrgTheme {
  primary:    string;
  sidebar:    string;
  accent:     string;
  background: string;
}

export interface OrgBranding {
  org_name:        string;
  tagline:         string;
  logo_url:        string;
  dashboard_title: string;
  theme:           OrgTheme;
}

export interface ModuleConfig {
  enabled: boolean;
}

export interface OrgModules {
  reports:          ModuleConfig;
  media_library:    ModuleConfig;
  notebook:         ModuleConfig;
  report_writer:    ModuleConfig;
  finance:          ModuleConfig;
  worker_analytics: ModuleConfig;
  social_posts:     ModuleConfig;
}

export interface AiConfig {
  system_persona:    string;
  default_language:  string;
  enabled_audiences: string[];
}

export interface DataSources {
  reports_sheet_id: string;
  users_sheet_id:   string;
  bq_dataset:       string;
  bq_project:       string;
}

export type CustomFieldType = 'text' | 'number' | 'select' | 'date';

export interface CustomFieldDef {
  key:       string;
  label:     string;
  type:      CustomFieldType;
  required?: boolean;
  options?:  string[];
}

export interface ProjectDef {
  id:    string;
  label: string;
  color: string;
}

export interface OrgMetadata {
  schema_version: number;
  branding:       OrgBranding;
  modules:        OrgModules;
  ai_config:      AiConfig;
  data_sources:   DataSources;
  custom_fields:  {
    daily_reports: CustomFieldDef[];
    users:         CustomFieldDef[];
  };
  projects:                ProjectDef[];
  contentHubPermissions?:  Record<string, string[]>;
  tabPermissions?:             Record<string, string[]>;
  userTabPermissions?:         Record<string, string[]>; // phone → allowed tab keys
  userContentHubPermissions?:  Record<string, string[]>; // phone → allowed content ids
  reportCategories?:           string[]; // Document Vault report category list, admin-managed
}

export interface PlanInfo {
  id:            string;
  name:          string;
  slug:          string;
  description:   string;
  price_monthly: number;
  max_users:     number;
  ai_enabled:    boolean;
  sort_order:    number;
  is_active:     boolean;
}

export type SubscriptionStatus = 'active' | 'trialing' | 'expired' | 'inactive' | 'suspended';

/** Server-computed access state (lib/subscriptionGuard.js computeAccess). */
export interface OrgAccess {
  state:          'ok' | 'grace' | 'read_only';
  reason?:        'expired' | 'suspended';
  expires_at?:    string | null;
  grace_ends_at?: string | null;
}

export interface OrgSubscription {
  plan:          PlanInfo | null;
  status:        SubscriptionStatus;
  expires_at:    string | null;
  billing_email: string;
  billing_notes: string;
  access?:       OrgAccess;
}
