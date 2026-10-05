// Tab keys + per-tab chunk loaders for DashboardPage. A leaf module (dynamic imports only)
// so App.tsx can fetch the landing tab's chunk in parallel with DashboardPage's own.

// All valid `activeTab` values (mirrors DashboardPage's union); synced with the URL hash
// so Back/Forward move between tabs.
export const ALL_TAB_KEYS = [
  'overview', 'reports', 'media', 'settings', 'impact', 'toc', 'notebook', 'analytics', 'whatsapp', 'actionplan', 'quickreport', 'content-hub',
  'generate-report', 'story-finder', 'project-report-picker', 'case-study-picker', 'org-report-picker', 'self-report-picker', 'team-report-picker', 'impact-report-picker', 'content-picker',
  'portfolio', 'orgdash', 'dashboard', 'vault', 'beneficiaries', 'financial', 'compliance', 'projectmedia', 'annualprogress',
  'mis', 'beneficiaryprofile', 'hr', 'financemgmt',
] as const;
export type AnyTabKey = typeof ALL_TAB_KEYS[number];

export const DEFAULT_TAB: AnyTabKey = 'orgdash';

export function tabFromHash(): AnyTabKey | null {
  // Compound hashes like '#settings/saved-reports' resolve to their base tab.
  const h = window.location.hash.replace(/^#/, '').split('/')[0];
  return (ALL_TAB_KEYS as readonly string[]).includes(h) ? (h as AnyTabKey) : null;
}

// Tabs whose body reads the Sheets/DB report list (ReportContext). Only these
// wait on the report sync; every other tab fetches its own data and renders
// immediately. 'settings' is here because User Management calls
// refreshReports() and relies on the remount that the loader causes.
export const REPORT_TABS: ReadonlySet<AnyTabKey> = new Set<AnyTabKey>([
  'overview', 'reports', 'media', 'impact', 'toc', 'notebook', 'analytics', 'settings', 'content-hub',
  'generate-report', 'story-finder', 'project-report-picker', 'case-study-picker', 'org-report-picker',
  'self-report-picker', 'team-report-picker', 'impact-report-picker', 'content-picker', 'projectmedia',
]);

export const TAB_MODULES = {
  'overview':              () => import('./OverviewPage'),
  'reports':               () => import('../cards/ReportCardGrid'),
  'media':                 () => import('./MediaLibraryTab'),
  'projectmedia':          () => import('./MediaLibraryTab'),
  'settings':              () => import('./SettingsPage'),
  'impact':                () => import('./ImpactDashboard'),
  'toc':                   () => import('./TocAnalysisPage'),
  'notebook':              () => import('../notebook/NotebookPage'),
  'analytics':             () => import('./WorkerAnalyticsTab'),
  'whatsapp':              () => import('../whatsapp/WhatsAppPage'),
  'actionplan':            () => import('./ActionPlanTab'),
  'quickreport':           () => import('./QuickReportTab'),
  'content-hub':           () => import('./ContentHubModal'),
  'generate-report':       () => import('./GenerateReportModal'),
  'story-finder':          () => import('./StoryFinderView'),
  'project-report-picker': () => import('./ProjectReportPickerView'),
  'case-study-picker':     () => import('./CaseStudyPickerView'),
  'org-report-picker':     () => import('./OrgReportPickerView'),
  'self-report-picker':    () => import('./SelfReportPickerView'),
  'team-report-picker':    () => import('./TeamReportPickerView'),
  'impact-report-picker':  () => import('./ImpactReportPickerView'),
  'content-picker':        () => import('./ContentPickerView'),
  'portfolio':             () => import('./PortfolioOverviewPage'),
  'orgdash':               () => import('./OrgDashboardPage'),
  'dashboard':             () => import('./ProjectDashboardPage'),
  'vault':                 () => import('./DocumentVaultPage'),
  'beneficiaries':         () => import('./BeneficiariesPage'),
  'financial':             () => import('./BudgetUtilisationPage'),
  'compliance':            () => import('./ComplianceCalendarPage'),
  'annualprogress':        () => import('./AnnualProgressReportPage'),
  'mis':                   () => import('./MisPage'),
  'beneficiaryprofile':    () => import('./BeneficiaryProfilePage'),
  'hr':                    () => import('../hr/HrManagementPage'),
  'financemgmt':           () => import('../finance-mgmt/FinanceManagementPage'),
} satisfies Record<AnyTabKey, () => Promise<unknown>>;

/** Prefetch a tab's chunk ahead of its first render. Errors are swallowed; the real
 *  render path surfaces them via ErrorBoundary / main.tsx's preloadError reload. */
export function preloadTab(key: AnyTabKey) {
  TAB_MODULES[key]().catch(() => {});
}
