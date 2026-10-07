import { useState, useMemo, useRef, useEffect, Suspense } from 'react';
import { SubscriptionBanner } from './SubscriptionBanner';
import {
  LogOut, Sparkles, Loader2,
  Globe, FileText,
  TrendingUp, Settings, Menu, Smartphone,
} from 'lucide-react';
import { useAuthContext } from '../../context/AuthContext';
import { useReportContext } from '../../context/ReportContext';
import { useLanguage } from '../../context/LanguageContext';
import { useProjectContext } from '../../context/ProjectContext';
import { FilterBar } from './FilterBar';
import { ErrorBoundary } from '../ErrorBoundary'
import { useOrg } from '../../context/OrgContext'
import { makeCanSeeTab } from '../../utils/tabAccess'
import { orgAppUrl } from '../org-app/orgAppRoute'
import { FF } from '../../theme/colors'
import { TabPill } from '../ui/TabPill'
import { lazyNamed } from '../../utils/lazyNamed'
import { apiFetch } from '../../utils/apiFetch'
import { localIsoDate } from '../../utils/format'
import { TAB_MODULES, DEFAULT_TAB, REPORT_TABS, tabFromHash, type AnyTabKey } from './dashboardTabs'
import type { ActiveFilters, DailyReport } from '../../types/report';

// Every tab body is its own chunk, fetched the first time that tab opens.
const ReportCardGrid           = lazyNamed(TAB_MODULES['reports'],               'ReportCardGrid');
const MediaLibraryTab          = lazyNamed(TAB_MODULES['media'],                 'MediaLibraryTab');
const GenerateReportPage       = lazyNamed(TAB_MODULES['generate-report'],       'GenerateReportPage');
const ContentHubTab            = lazyNamed(TAB_MODULES['content-hub'],           'ContentHubTab');
const StoryFinderView          = lazyNamed(TAB_MODULES['story-finder'],          'StoryFinderView');
const ProjectReportPickerView  = lazyNamed(TAB_MODULES['project-report-picker'], 'ProjectReportPickerView');
const OrgReportPickerView      = lazyNamed(TAB_MODULES['org-report-picker'],     'OrgReportPickerView');
const SelfReportPickerView     = lazyNamed(TAB_MODULES['self-report-picker'],    'SelfReportPickerView');
const CaseStudyPickerView      = lazyNamed(TAB_MODULES['case-study-picker'],     'CaseStudyPickerView');
const TeamReportPickerView     = lazyNamed(TAB_MODULES['team-report-picker'],    'TeamReportPickerView');
const ImpactReportPickerView   = lazyNamed(TAB_MODULES['impact-report-picker'],  'ImpactReportPickerView');
const ContentPickerView        = lazyNamed(TAB_MODULES['content-picker'],        'ContentPickerView');
const OverviewPage             = lazyNamed(TAB_MODULES['overview'],              'OverviewPage');
const SettingsPage             = lazyNamed(TAB_MODULES['settings'],              'SettingsPage');
const ImpactDashboard          = lazyNamed(TAB_MODULES['impact'],                'ImpactDashboard');
const TocAnalysisPage          = lazyNamed(TAB_MODULES['toc'],                   'TocAnalysisPage');
const NotebookPage             = lazyNamed(TAB_MODULES['notebook'],              'NotebookPage');
const WorkerAnalyticsTab       = lazyNamed(TAB_MODULES['analytics'],             'WorkerAnalyticsTab');
const WhatsAppPage             = lazyNamed(TAB_MODULES['whatsapp'],              'WhatsAppPage');
const ActionPlanTab            = lazyNamed(TAB_MODULES['actionplan'],            'ActionPlanTab');
const QuickReportTab           = lazyNamed(TAB_MODULES['quickreport'],           'QuickReportTab');
const PortfolioOverviewPage    = lazyNamed(TAB_MODULES['portfolio'],             'PortfolioOverviewPage');
const OrgDashboardPage         = lazyNamed(TAB_MODULES['orgdash'],               'OrgDashboardPage');
const ProjectDashboardPage     = lazyNamed(TAB_MODULES['dashboard'],             'ProjectDashboardPage');
const DocumentVaultPage        = lazyNamed(TAB_MODULES['vault'],                 'DocumentVaultPage');
const BeneficiariesPage        = lazyNamed(TAB_MODULES['beneficiaries'],         'BeneficiariesPage');
const MisPage                  = lazyNamed(TAB_MODULES['mis'],                   'MisPage');
const BeneficiaryProfilePage   = lazyNamed(TAB_MODULES['beneficiaryprofile'],    'BeneficiaryProfilePage');
const HrManagementPage         = lazyNamed(TAB_MODULES['hr'],                    'HrManagementPage');
const FormsPage                = lazyNamed(TAB_MODULES['forms'],                 'FormsPage');
const FinanceManagementPage    = lazyNamed(TAB_MODULES['financemgmt'],           'FinanceManagementPage');
const CustomDashboardPage      = lazyNamed(TAB_MODULES['custom'],                'CustomDashboardPage');
const ComplianceCalendarPage   = lazyNamed(TAB_MODULES['compliance'],            'ComplianceCalendarPage');
const AnnualProgressReportPage = lazyNamed(TAB_MODULES['annualprogress'],        'AnnualProgressReportPage');
const BudgetUtilisationPage    = lazyNamed(TAB_MODULES['financial'],             'BudgetUtilisationPage');
const SocialPostModal          = lazyNamed(() => import('./SocialPostModal'),    'SocialPostModal');
const UserProfileModal         = lazyNamed(() => import('./UserProfileModal'),   'UserProfileModal');
const AIAssistantPanel         = lazyNamed(() => import('./AIAssistantPanel'),   'AIAssistantPanel');

// bg/sidebar/dark follow the org theme (CSS vars set by OrgContext's applyTheme),
// falling back to FF. Use only in style props — `${C.dark}22` would be invalid CSS.
const C = {
  bg:      `var(--color-background, ${FF.bg})`,       // page background
  sidebar: `var(--color-sidebar, ${FF.tealDark})`,    // sidebar / mobile header
  lime:    '#16a34a',   // green — beneficiary/impact accent (kept distinct from FF.green)
  dark:    `var(--color-primary, ${FF.tealDark})`,    // primary — CTA card, report bars, pills
  white:   '#FFFFFF',
  pill:    '#DDD6FE',   // light violet pill
};

function PillRow({
  filled, total = 10, color = C.dark,
}: { filled: number; total?: number; color?: string }) {
  const f = Math.min(Math.max(Math.round(filled), 0), total);
  return (
    <div className="flex gap-1 flex-wrap mt-3">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 20, height: 10,
            borderRadius: 999,
            background: i < f ? color : C.pill,
            transition: 'background 0.3s',
          }}
        />
      ))}
    </div>
  );
}

function ActivityChart({
  data,
}: {
  data: { label: string; reports: number; outreach: number }[];
}) {
  const maxR = Math.max(...data.map(d => d.reports), 1);
  const maxO = Math.max(...data.map(d => d.outreach), 1);

  return (
    <div className="flex items-end gap-1.5" style={{ height: 128 }}>
      {data.map((day, i) => {
        const rh = Math.max((day.reports / maxR) * 104, day.reports > 0 ? 8 : 3);
        const oh = Math.max((day.outreach / maxO) * 104, day.outreach > 0 ? 8 : 3);
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center gap-0.5"
            title={`${day.label}: ${day.reports} reports, ${day.outreach} outreach`}
          >
            <div className="flex items-end gap-[3px]" style={{ height: 110 }}>
              <div
                style={{
                  width: 7, height: rh,
                  borderRadius: 999,
                  background: C.dark,
                  transition: 'height 0.5s',
                }}
              />
              <div
                style={{
                  width: 7, height: oh,
                  borderRadius: 999,
                  background: C.lime,
                  transition: 'height 0.5s',
                }}
              />
            </div>
            <div style={{ fontSize: 8, color: '#9CA3AF', whiteSpace: 'nowrap' }}>
              {day.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Inline stand-in for a tab body while its chunk (or the report sync) loads —
// keeps the sidebar/header on screen instead of blanking the whole page.
function TabLoader({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <Loader2 className="w-7 h-7 animate-spin" style={{ color: C.lime }} />
      {label && <p className="text-sm animate-pulse" style={{ color: '#6B7280' }}>{label}</p>}
    </div>
  );
}

// Shown for every tab except HR when the app started without a network:
// org data, reports and projects never loaded, so only HR (which keeps its
// own copy on the device) can work.
function OfflineTabNotice({ onOpenHr }: { onOpenHr?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center" role="status">
      <p className="text-sm font-semibold" style={{ color: FF.tealDark }}>You're offline</p>
      <p className="text-sm max-w-md" style={{ color: FF.textMuted }}>
        This page needs an internet connection. HR Management works offline — check-ins and leave requests sync when you reconnect.
      </p>
      <div className="flex gap-2">
        {onOpenHr && (
          <button type="button" onClick={onOpenHr} className="px-4 py-2 rounded-lg text-sm font-semibold"
            style={{ background: FF.purple, color: '#fff' }}>Open HR Management</button>
        )}
        <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-lg text-sm font-semibold"
          style={{ border: `1px solid ${FF.border}`, color: FF.tealDark }}>Retry</button>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { user, logout, offlineSession } = useAuthContext();
  const { reports, users, loading } = useReportContext();
  const { t, lang, setLang, languages } = useLanguage();
  const { org, orgSlug } = useOrg();
  const { selectedProject, selectedProjectKey, selectProject, loadProjects } = useProjectContext();
  const [showLangMenu, setShowLangMenu] = useState(false);
  // Slide-out nav drawer below lg, where the sidebar itself is hidden.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const [filters, setFilters] = useState<ActiveFilters>({
    project: [], state: [], area: [], dateFrom: '', dateTo: '', workerName: [],
  });
  // Some tabs (generate-report, story-finder, the pickers) have no nav entry;
  // they're opened from Content Hub tiles.
  const [activeTab, setActiveTab] = useState<AnyTabKey>(() => offlineSession ? 'hr' : (tabFromHash() ?? DEFAULT_TAB));
  // Ask AI notebook outputs keep generating while you visit other sections:
  // the notebook page stays mounted (hidden) until nothing is in flight.
  const [notebookBusy, setNotebookBusy] = useState(false);

  // Sync the URL hash with activeTab so Back/Forward work. Only writing when it
  // differs avoids a loop with the hashchange listener below.
  useEffect(() => {
    // Compare only the base tab so a sub-path deep link ('#settings/saved-reports') survives.
    if (window.location.hash.replace(/^#/, '').split('/')[0] === activeTab) return;
    window.location.hash = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const onHashChange = () => {
      const tab = tabFromHash();
      if (tab && tab !== activeTab) setActiveTab(tab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [activeTab]);
  const [showProfile, setShowProfile] = useState(false);
  // Tab to return to when an inline report/picker page is closed.
  const previousTabRef = useRef<typeof activeTab>('overview');
  const [reportConfig, setReportConfig] = useState<{
    reports: DailyReport[]; title: string; instruction?: string;
    // "Generate Report for Other" identity
    subjects?: { id?: string; name: string; phone?: string }[];
    kind?: 'self' | 'for_other' | 'team';
    pendingSubjectPick?: boolean;
    // Overrides the global `filters` for this generation (e.g. a Content Hub
    // picker's own project/date selection).
    filters?: ActiveFilters;
    // Report output language picked in Content Hub — not the UI language.
    language?: string;
  } | null>(null);
  const [socialConfig, setSocialConfig] = useState<{
    reports: DailyReport[]; scope: 'project' | 'organization'; scopeName: string; platform?: string;
  } | null>(null);
  // Per-picker config (title + resolved AI instruction), set when its Content Hub tile is clicked.
  const [projectReportPickerConfig, setProjectReportPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);
  const [caseStudyPickerConfig, setCaseStudyPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);
  const [orgReportPickerConfig, setOrgReportPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);
  const [selfReportPickerConfig, setSelfReportPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);
  const [teamReportPickerConfig, setTeamReportPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);
  const [impactReportPickerConfig, setImpactReportPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);
  // Generic picker for content tiles without a bespoke one.
  const [contentPickerConfig, setContentPickerConfig] = useState<{
    title: string; instruction: string;
  } | null>(null);

  // Role-scoped base reports
  const normalize = (p: string | null | undefined) => {
    if (!p) return '';
    const c = p.replace(/[\s\-]/g, '').replace(/^\+/, '');
    return c.length === 10 ? '91' + c : c;
  };

  const baseReports = useMemo(() => {
    if (user?.role === 'admin' || user?.role === 'superadmin') return reports;
    if (user?.role === 'manager') {
      const myName  = String(user.name  || '').toLowerCase();
      const myPhone = normalize(user.phone);
      const subPhones = new Set(
        users
          .filter(u => {
            const m = String(u.manager || '').toLowerCase();
            return m === myName || normalize(m) === myPhone || String(u.name || '').toLowerCase() === myName;
          })
          .map(u => normalize(u.phone))
      );
      return reports.filter(r => subPhones.has(normalize(r.phone)));
    }
    const myPhone = normalize(user?.phone ?? '');
    return reports.filter(r => normalize(r.phone) === myPhone);
  }, [user, reports, users]);

  // The user's own submissions regardless of role (from `reports`, not the
  // role-scoped `baseReports`), for the Self Report picker.
  const selfReports = useMemo(() => {
    const myPhone = normalize(user?.phone ?? '');
    return reports.filter(r => normalize(r.phone) === myPhone);
  }, [user, reports]);

  // Everyone else in `baseReports`, for the Team Report picker; falls back to
  // `baseReports` when that would be empty.
  const teamReports = useMemo(() => {
    const myPhone = normalize(user?.phone ?? '');
    const others = baseReports.filter(r => normalize(r.phone) !== myPhone);
    return others.length > 0 ? others : baseReports;
  }, [user, baseReports]);

  const filteredReports = useMemo(() => {
    return baseReports.filter(r => {
      if (filters.workerName.length > 0 && !filters.workerName.includes(r.name)) return false;
      if (filters.project.length > 0   && !filters.project.includes(r.project))   return false;
      if (filters.state.length > 0     && !filters.state.includes(r.state))       return false;
      if (filters.area.length > 0      && !filters.area.includes(r.areaOfIntervention)) return false;
      if (filters.dateFrom || filters.dateTo) {
        const date = typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : '';
        if (!date) return false;
        if (filters.dateFrom && date < filters.dateFrom) return false;
        if (filters.dateTo   && date > filters.dateTo)   return false;
      }
      return true;
    });
  }, [baseReports, filters]);

  const totalOutreach = useMemo(() =>
    filteredReports.reduce((acc, r) => acc + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0),
    [filteredReports]
  );
  const uniqueProjects   = new Set(filteredReports.map(r => r.project).filter(Boolean)).size;
  const uniqueStates     = new Set(filteredReports.map(r => r.state).filter(Boolean)).size;
  const withAttachment   = filteredReports.filter(r => r.attachmentUrl).length;
  const totalBase        = Math.max(baseReports.length, 1);
  const reportPct        = Math.round((filteredReports.length / totalBase) * 100);
  const reportPills      = Math.round((filteredReports.length / totalBase) * 10);
  const attachPct        = filteredReports.length > 0
    ? Math.round((withAttachment / filteredReports.length) * 100) : 0;

  const chartData = useMemo(() => {
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      const dateStr = localIsoDate(d);
      const day = filteredReports.filter(r => String(r.timestamp).slice(0, 10) === dateStr);
      return {
        label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        reports: day.length,
        outreach: day.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0),
      };
    });
  }, [filteredReports]);

  // Title reflecting the filters; callers with their own scope pass `scopeFilters`.
  function buildReportTitle(base: string, scopeFilters: ActiveFilters = filters): string {
    const parts: string[] = []

    if (scopeFilters.project.length === 1)
      parts.push(scopeFilters.project[0])
    else if (scopeFilters.project.length > 1)
      parts.push(`${scopeFilters.project.length} Projects`)

    if (scopeFilters.state.length === 1)
      parts.push(scopeFilters.state[0])
    else if (scopeFilters.state.length > 1)
      parts.push(`${scopeFilters.state.length} States`)

    if (scopeFilters.workerName.length === 1)
      parts.push(scopeFilters.workerName[0])
    else if (scopeFilters.workerName.length > 1)
      parts.push(`${scopeFilters.workerName.length} Team Members`)

    if (scopeFilters.area.length === 1)
      parts.push(scopeFilters.area[0])
    else if (scopeFilters.area.length > 1)
      parts.push(`${scopeFilters.area.length} Areas`)

    if (scopeFilters.location && scopeFilters.location.length === 1)
      parts.push(scopeFilters.location[0])
    else if (scopeFilters.location && scopeFilters.location.length > 1)
      parts.push(`${scopeFilters.location.length} Locations`)

    if (scopeFilters.dateFrom || scopeFilters.dateTo) {
      const fmt = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      const from = scopeFilters.dateFrom ? fmt(scopeFilters.dateFrom) : 'Start'
      const to   = scopeFilters.dateTo ? fmt(scopeFilters.dateTo) : 'Now'
      parts.push(`${from} – ${to}`)
    }

    return parts.length ? `${base} — ${parts.join(' · ')}` : base
  }

  const openReport = (
    title: string,
    data: DailyReport[],
    instruction?: string,
    options?: {
      subjects?: { id?: string; name: string; phone?: string }[]
      kind?: 'self' | 'for_other' | 'team'
      pendingSubjectPick?: boolean
      filters?: ActiveFilters
      language?: string
    },
  ) => {
    setReportConfig({
      reports: data,
      title: buildReportTitle(title, options?.filters),
      instruction,
      subjects: options?.subjects,
      kind: options?.kind,
      pendingSubjectPick: options?.pendingSubjectPick,
      filters: options?.filters,
      language: options?.language,
    });
    previousTabRef.current = activeTab === 'generate-report' ? 'overview' : activeTab;
    setActiveTab('generate-report');
  };
  const closeReport = () => {
    setReportConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openStoryFinder  = () => {
    previousTabRef.current = activeTab === 'story-finder' ? 'overview' : activeTab;
    setActiveTab('story-finder');
  };
  const closeStoryFinder = () => {
    setActiveTab(previousTabRef.current);
  };
  const openProjectReportPicker = (title: string, instruction: string) => {
    setProjectReportPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'project-report-picker' ? 'overview' : activeTab;
    setActiveTab('project-report-picker');
  };
  const closeProjectReportPicker = () => {
    setProjectReportPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openCaseStudyPicker = (title: string, instruction: string) => {
    setCaseStudyPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'case-study-picker' ? 'overview' : activeTab;
    setActiveTab('case-study-picker');
  };
  const closeCaseStudyPicker = () => {
    setCaseStudyPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openOrgReportPicker = (title: string, instruction: string) => {
    setOrgReportPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'org-report-picker' ? 'overview' : activeTab;
    setActiveTab('org-report-picker');
  };
  const closeOrgReportPicker = () => {
    setOrgReportPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openSelfReportPicker = (title: string, instruction: string) => {
    setSelfReportPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'self-report-picker' ? 'overview' : activeTab;
    setActiveTab('self-report-picker');
  };
  const closeSelfReportPicker = () => {
    setSelfReportPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openTeamReportPicker = (title: string, instruction: string) => {
    setTeamReportPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'team-report-picker' ? 'overview' : activeTab;
    setActiveTab('team-report-picker');
  };
  const closeTeamReportPicker = () => {
    setTeamReportPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openImpactReportPicker = (title: string, instruction: string) => {
    setImpactReportPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'impact-report-picker' ? 'overview' : activeTab;
    setActiveTab('impact-report-picker');
  };
  const closeImpactReportPicker = () => {
    setImpactReportPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };
  const openContentPicker = (title: string, instruction: string) => {
    setContentPickerConfig({ title, instruction });
    previousTabRef.current = activeTab === 'content-picker' ? 'overview' : activeTab;
    setActiveTab('content-picker');
  };
  const closeContentPicker = () => {
    setContentPickerConfig(null);
    setActiveTab(previousTabRef.current);
  };

  // Contributors offered when no subject is picked — from baseReports, so only
  // people whose data the user may view.
  const availableContributors = useMemo(() => {
    const seen = new Map<string, { name: string; phone?: string }>()
    for (const r of baseReports) {
      const key = String(r.name || '').toLowerCase().trim()
      if (!key || seen.has(key)) continue
      seen.set(key, { name: r.name, phone: r.phone })
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [baseReports]);
  const openSocial = (
    scope: 'project' | 'organization', scopeName: string,
    data: DailyReport[], platform?: string,
  ) => setSocialConfig({ reports: data, scope, scopeName, platform });

  // Only tabs that read the report list wait for the sync; the rest render and
  // fetch their own data in parallel.
  const reportsPending = loading && REPORT_TABS.has(activeTab);

  const isAdmin   = user?.role === 'admin' || user?.role === 'superadmin';
  const isManager = user?.role === 'manager';
  const canImpact = isAdmin || isManager;

  type TabKey = 'overview' | 'reports' | 'media' | 'settings' | 'impact' | 'toc' | 'notebook' | 'analytics' | 'whatsapp' | 'actionplan' | 'quickreport' | 'content-hub'
    | 'portfolio' | 'orgdash' | 'dashboard' | 'vault' | 'beneficiaries' | 'financial' | 'compliance' | 'projectmedia' | 'annualprogress'
    | 'mis' | 'beneficiaryprofile' | 'hr' | 'financemgmt' | 'custom' | 'forms';

  // The report FilterBar and hero cards are scoped to daily_reports, so only
  // the tabs that list those reports show them.
  const SHOW_FILTER_BAR  = activeTab === 'overview' || activeTab === 'reports' || activeTab === 'media';
  const SHOW_HERO_CARDS  = activeTab === 'overview';

  const PAGE_META: Partial<Record<TabKey, { title: string; desc: string }>> = {
    portfolio:     { title: 'Portfolio Overview', desc: 'Every project across the org — health, budget, target achievement and compliance at a glance.' },
    orgdash:       { title: 'Org Dashboard',      desc: 'Combined growth across every active project' },
    impact:        { title: 'Impact Dashboard',   desc: 'Beneficiaries, categories, locations and Theory of Change' },
    reports:       { title: 'Reports',            desc: 'Every field report submitted across the portfolio' },
    analytics:     { title: 'Performance Review', desc: 'Field staff activity, reach and report quality' },
    media:         { title: 'Media',              desc: 'Photos attached to field reports' },
    notebook:      { title: 'Ask AI',             desc: "Ask questions grounded in your uploaded documents" },
    whatsapp:      { title: 'WhatsApp',           desc: 'Flows, broadcasts, collections & conversations' },
    'content-hub': { title: 'Content Hub',        desc: 'Generate reports, articles and social posts from your field data' },
    dashboard:     { title: 'Dashboard',          desc: selectedProject?.name ?? '' },
    vault:         { title: 'Document Vault',     desc: 'Legal, financial, progress & knowledge documents' },
    projectmedia:  { title: 'Media',              desc: 'Photos attached to this project\'s field reports' },
    beneficiaries: { title: 'Beneficiary and Resource Registration', desc: 'Individual/Entrepreneur/Collective/Resources rosters, plus an org-wide coverage & headcount dashboard' },
    financial:     { title: 'Financial Tracker',  desc: 'Budget utilisation and burn rate' },
    compliance:    { title: 'Compliance Calendar',desc: 'Due dates, renewals and certificate expiry' },
    annualprogress:{ title: 'Annual Progress Report', desc: selectedProject?.name ?? '' },
    beneficiaryprofile: { title: 'Beneficiary Profile', desc: 'Individual, Micro-Entrepreneur & Collective records — complete detail plus recorded MIS data' },
    hr:            { title: 'HR Management',      desc: 'Attendance and leave — works offline, syncs when you reconnect' },
    financemgmt:   { title: 'Finance Management', desc: 'Advances, settlements, ledger statements and compliance due dates' },
    custom:        { title: 'Custom Dashboards',  desc: 'Dashboards set up for your organisation' },
    actionplan:    { title: 'Action Plan',        desc: selectedProject?.name ?? '' },
    mis:           { title: 'MIS',                desc: 'Training, distribution, scheme access, credit/grant, support & event records — split by beneficiary type, scoped to this project.' },
    settings:      { title: 'Settings',           desc: '' },
    overview:      { title: t.tabOverview,        desc: '' },
    toc:           { title: 'ToC Analysis',       desc: '' },
    quickreport:   { title: 'Quick Report',       desc: '' },
  };
  const pageMeta = PAGE_META[activeTab as TabKey] ?? { title: '', desc: '' };

  const canSeeTab = makeCanSeeTab(user, org)

  // Custom dashboards are built per org by the super admin; the nav item only
  // appears once at least one is visible to this user.
  const [hasCustom, setHasCustom] = useState(false);
  useEffect(() => {
    if (!user?.orgId || offlineSession) return;
    apiFetch('/api/custom-dashboards')
      .then(r => (r.ok ? r.json() : []))
      .then(rows => setHasCustom(Array.isArray(rows) && rows.length > 0))
      .catch(() => {});
  }, [user?.orgId, offlineSession]);

  // Portfolio lives on a header button; 'overview' and 'toc' are reachable by
  // tab state/hash only.
  const sidebarNav: { key: TabKey; label: string; badge: string }[] = [
    ...(canSeeTab('orgdash')   ? [{ key: 'orgdash'   as TabKey, label: 'Org Dashboard', badge: 'Od' }] : []),
    ...(hasCustom ? [{ key: 'custom' as TabKey, label: 'Custom Dashboards', badge: 'Cd' }] : []),
    ...(canImpact && canSeeTab('impact') ? [{ key: 'impact' as TabKey, label: t.tabImpact ?? 'Impact', badge: 'Im' }] : []),
    ...(canSeeTab('reports')   ? [{ key: 'reports'   as TabKey, label: t.tabReports, badge: 'Rp' }] : []),
    ...(canSeeTab('analytics') ? [{ key: 'analytics' as TabKey, label: t.tabPerformanceReview, badge: 'Pf' }] : []),
    ...(canSeeTab('media')     ? [{ key: 'media'     as TabKey, label: t.tabMedia, badge: 'Md' }] : []),
    ...(canSeeTab('notebook')  ? [{ key: 'notebook'  as TabKey, label: 'Ask AI', badge: 'Ai' }] : []),
    ...(canSeeTab('whatsapp')  ? [{ key: 'whatsapp'  as TabKey, label: 'WhatsApp', badge: 'Wa' }] : []),
    ...(canSeeTab('beneficiaryprofile') ? [{ key: 'beneficiaryprofile' as TabKey, label: 'Beneficiary Profile', badge: 'Bp' }] : []),
    // Org-wide: most of its sub-tabs are org-wide rosters.
    ...(canSeeTab('beneficiaries') ? [{ key: 'beneficiaries' as TabKey, label: 'Beneficiary and Resource Registration', badge: 'Bn' }] : []),
    ...(canSeeTab('forms') ? [{ key: 'forms' as TabKey, label: 'Forms', badge: 'Fo' }] : []),
    { key: 'content-hub' as TabKey, label: 'Content Hub', badge: 'Ch' },
  ];

  const orgMgmtNav: { key: TabKey; label: string; badge: string }[] = [
    ...(canSeeTab('hr') ? [{ key: 'hr' as TabKey, label: 'HR Management', badge: 'Hr' }] : []),
    ...(canSeeTab('financemgmt') ? [{ key: 'financemgmt' as TabKey, label: 'Finance Management', badge: 'Fm' }] : []),
  ];

  const renderNavItem = ({ key, label, badge }: { key: TabKey; label: string; badge: string }) => {
    const active = activeTab === key
    return (
      <button
        key={key}
        onClick={() => selectTab(key)}
        aria-current={active ? 'page' : undefined}
        className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-all"
        style={{
          background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
          // Org theme accent as the active-item marker (no theme → none)
          boxShadow: active ? 'inset 3px 0 0 var(--color-accent, transparent)' : 'none',
        }}
      >
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0"
          style={{ background: active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)', color: FF.sidebarText }}
        >
          {badge}
        </span>
        <span className="text-[13px] font-medium" style={{ color: active ? FF.sidebarText : FF.sidebarTextDim }}>
          {label}
        </span>
      </button>
    )
  }

  // Per-project pill row, shown once a project is selected.
  const projectSubTabs: { key: TabKey; label: string }[] = selectedProjectKey ? [
    { key: 'dashboard' as TabKey, label: 'Dashboard' },
    ...(canSeeTab('vault')         ? [{ key: 'vault'         as TabKey, label: 'Document Vault' }] : []),
    ...(canSeeTab('projectmedia')  ? [{ key: 'projectmedia'  as TabKey, label: 'Media' }] : []),
    ...(canImpact ? [{ key: 'actionplan' as TabKey, label: 'Action Plan' }] : []),
    ...(canSeeTab('financial')     ? [{ key: 'financial'     as TabKey, label: 'Financial Tracker' }] : []),
    ...(canSeeTab('compliance')    ? [{ key: 'compliance'    as TabKey, label: 'Compliance Calendar' }] : []),
    ...(canImpact && canSeeTab('annualprogress') ? [{ key: 'annualprogress' as TabKey, label: 'Annual Progress Report' }] : []),
    ...(canSeeTab('mis') ? [{ key: 'mis' as TabKey, label: 'MIS' }] : []),
  ] : [];

  function selectTab(tab: TabKey) {
    setActiveTab(tab);
    setMobileNavOpen(false);
  }

  // Warm the HR chunk + data shortly after an online start so staff who never
  // opened HR can still check in offline later.
  const hrVisible = canSeeTab('hr');
  useEffect(() => {
    if (!user || offlineSession || !hrVisible) return;
    const id = window.setTimeout(() => {
      TAB_MODULES['hr']().then(m => m.warmHrOffline(`${user.orgId}:${user.uid}`)).catch(() => {});
    }, 4000);
    return () => window.clearTimeout(id);
  }, [user, offlineSession, hrVisible]);

  // Rendered in both the desktop <aside> and the mobile drawer.
  function renderSidebarBody() {
    return (
      <>
        <div className="px-6 pt-6 pb-5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 overflow-hidden">
            <img src={org?.branding?.logo_url || '/logo.png'} alt="Logo" className="w-9 h-9 object-contain" />
          </div>
          <div>
            <div className="font-bold text-[15px] leading-tight" style={{ color: FF.sidebarText, fontFamily: "'Newsreader',serif" }}>
              {org?.branding?.org_name || 'Field Flow'}
            </div>
            <div className="text-[10px] uppercase tracking-widest font-semibold mt-0.5" style={{ color: FF.sidebarTextDimmer }}>
              Project Intelligence Hub
            </div>
          </div>
        </div>

        <div className="px-6 pb-5">
          <div className="text-[10px] uppercase tracking-widest font-semibold mb-2" style={{ color: FF.sidebarTextDimmer }}>
            Current Workspace
          </div>
          {selectedProject ? (
            <div>
              <div className="text-[13.5px] font-semibold leading-snug" style={{ color: FF.sidebarText, fontFamily: "'Newsreader',serif" }}>
                {selectedProject.name}
              </div>
              {selectedProject.donor && (
                <div className="text-[11.5px] mt-1" style={{ color: FF.sidebarTextDim }}>{selectedProject.donor}</div>
              )}
            </div>
          ) : (
            <div className="text-[11.5px] leading-relaxed" style={{ color: FF.sidebarTextDim }}>
              No project open yet. Pick one from Portfolio Overview to see its Dashboard, Vault, Action Plan, Financial Tracker and Compliance Calendar.
            </div>
          )}
        </div>

        <div className="mx-6 border-t" style={{ borderColor: 'rgba(255,255,255,0.1)' }} />

        <nav className="px-4 pt-5 flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest font-semibold px-2 mb-1.5" style={{ color: FF.sidebarTextDimmer }}>
            Organisation-wide
          </div>
          {sidebarNav.map(renderNavItem)}
        </nav>

        {orgMgmtNav.length > 0 && (
          <nav className="px-4 pt-5 flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-widest font-semibold px-2 mb-1.5" style={{ color: FF.sidebarTextDimmer }}>
              Organisation Management
            </div>
            {orgMgmtNav.map(renderNavItem)}
            {/* The same two tabs as an installable phone app (components/org-app). */}
            <a
              href={orgAppUrl(orgSlug)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] font-medium hover:opacity-80 transition"
              style={{ color: FF.sidebarTextDim }}
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              Open as phone app
            </a>
          </nav>
        )}

        <div className="mt-auto">
          <div className="mx-6 border-t" style={{ borderColor: 'rgba(255,255,255,0.1)' }} />

          <div className="px-6 pt-4 flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => setActiveTab('settings')}
                aria-label="Settings"
                aria-current={activeTab === 'settings' ? 'page' : undefined}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                style={{ background: activeTab === 'settings' ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.08)' }}
              >
                <Settings className="w-3.5 h-3.5" style={{ color: activeTab === 'settings' ? FF.sidebarText : FF.sidebarTextDimmer }} />
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setShowLangMenu(v => !v)}
                aria-label={t.language}
                className="w-7 h-7 rounded-lg flex items-center justify-center hover:opacity-80 transition"
                style={{ background: 'rgba(255,255,255,0.08)' }}
              >
                <Globe className="w-3.5 h-3.5" style={{ color: FF.sidebarTextDimmer }} />
              </button>
              {showLangMenu && (
                <div
                  className="absolute left-0 bottom-9 z-50 rounded-2xl shadow-2xl overflow-hidden w-40"
                  style={{ background: C.sidebar, border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {languages.map(l => (
                    <button
                      key={l.code}
                      onClick={() => { setLang(l.code); setShowLangMenu(false); }}
                      className="w-full text-left px-4 py-2.5 text-xs font-semibold flex items-center justify-between hover:opacity-80 transition"
                      style={{
                        color: lang === l.code ? C.lime : 'rgba(255,255,255,0.7)',
                        background: lang === l.code ? 'rgba(22,163,74,0.15)' : 'transparent',
                      }}
                    >
                      <span>{l.native}</span>
                      {lang === l.code && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: C.lime }} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setShowProfile(true)}
              aria-label={`View profile (${user?.name ?? 'User'})`}
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold hover:opacity-80 transition ml-auto"
              style={{ background: 'rgba(255,255,255,0.18)', color: FF.sidebarText }}
            >
              {(user?.name ?? 'U').charAt(0).toUpperCase()}
            </button>
          </div>

          <div className="px-6 py-4">
            <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: FF.sidebarTextDimmer }}>
              Signed in as
            </div>
            <div className="text-[13px] font-semibold mt-0.5" style={{ color: FF.sidebarText }}>
              {user?.role} · {user?.name}
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: C.bg }}>

      {/* Desktop sidebar (≥ lg) */}
      <aside
        className="hidden lg:flex flex-col w-[260px] shrink-0 overflow-y-auto"
        style={{ background: C.sidebar }}
      >
        {renderSidebarBody()}
      </aside>

      {/* Mobile/tablet nav drawer (< lg) */}
      {mobileNavOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="relative z-10 flex flex-col w-[280px] max-w-[85vw] h-full overflow-y-auto"
            style={{ background: C.sidebar }}
          >
            {renderSidebarBody()}
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        <SubscriptionBanner />

        <header
          className="lg:hidden flex items-center justify-between px-4 py-3 shrink-0"
          style={{ background: C.sidebar }}
        >
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="w-8 h-8 -ml-1 rounded-lg flex items-center justify-center hover:opacity-80 transition shrink-0"
              style={{ background: 'rgba(255,255,255,0.12)' }}
            >
              <Menu className="w-4.5 h-4.5 text-white" />
            </button>
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center overflow-hidden"
            >
              <img src={org?.branding?.logo_url || '/logo.png'} alt="Logo" className="w-7 h-7 object-contain" />
            </div>
            <span className="text-white font-black text-sm tracking-tight">FieldFlow</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('content-hub')}
              className="w-8 h-8 rounded-xl flex items-center justify-center hover:opacity-80 transition"
              style={{ background: 'rgba(255,255,255,0.12)' }}
              title={t.generateContent}
            >
              <Sparkles className="w-4 h-4 text-white" />
            </button>
            <button onClick={logout} className="p-1.5 text-white/60 hover:text-white transition">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Page header + project sub-nav, shown on every tab */}
        {pageMeta.title && (
          <div className="px-4 lg:px-8 pt-4 lg:pt-6 pb-3 shrink-0" style={{ background: FF.bgWarm }}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-2xl lg:text-[28px] font-bold leading-tight" style={{ color: FF.tealDark, fontFamily: "'Newsreader',serif" }}>
                  {pageMeta.title}
                </h1>
                {pageMeta.desc && (
                  <p className="text-xs mt-1.5 max-w-md" style={{ color: FF.textMuted }}>{pageMeta.desc}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => selectTab('portfolio')}
                  className="px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition"
                  style={{ background: '#FFFFFF', color: FF.tealDark, border: `1px solid ${FF.border}` }}
                >
                  Portfolio Overview
                </button>
              </div>
            </div>

            {/* Only on the per-project pages themselves */}
            {projectSubTabs.some(t => t.key === activeTab) && (
              <div className="mt-4 overflow-x-auto no-scrollbar">
                <TabPill tabs={projectSubTabs} active={activeTab as TabKey} onChange={selectTab} size="xs" />
              </div>
            )}
          </div>
        )}

        <div className="flex flex-1 min-w-0 overflow-hidden">

          {/* Notebook, full-bleed */}
          {(activeTab === 'notebook' || notebookBusy) && (
            <div className={activeTab === 'notebook' ? 'flex-1 min-w-0 overflow-hidden' : 'hidden'}>
              {reportsPending && !notebookBusy ? <TabLoader label={t.syncingData} /> : (
                <ErrorBoundary>
                  <Suspense fallback={<TabLoader />}>
                    <NotebookPage
                      baseReports={baseReports}
                      filteredReports={filteredReports}
                      filters={filters}
                      onBusyChange={setNotebookBusy}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          )}

          {/* WhatsApp, full-bleed */}
          {activeTab === 'whatsapp' && canSeeTab('whatsapp') && (
            <div className="flex-1 min-w-0 overflow-auto p-4 lg:p-8">
              <ErrorBoundary>
                <Suspense fallback={<TabLoader />}>
                  <WhatsAppPage />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* Center column */}
          <div className={`${activeTab === 'notebook' || activeTab === 'whatsapp' ? 'hidden' : 'flex-1'} p-4 lg:p-8 min-w-0 overflow-auto`}>

            {offlineSession && activeTab !== 'hr'
              ? <OfflineTabNotice onOpenHr={canSeeTab('hr') ? () => setActiveTab('hr') : undefined} />
              : reportsPending ? <TabLoader label={t.syncingData} /> : <>

            {SHOW_FILTER_BAR && (
              <FilterBar reports={baseReports} filters={filters} onChange={setFilters} />
            )}

            {/* Hero stat cards (legacy Overview tab only) */}
            {SHOW_HERO_CARDS && <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">

              <div className="rounded-2xl sm:rounded-3xl p-4 sm:p-5" style={{ background: C.white }}>
                <div className="flex items-center justify-between mb-2 sm:mb-3">
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <div
                      className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg sm:rounded-xl flex items-center justify-center"
                      style={{ background: '#F3F4F6' }}
                    >
                      <FileText className="w-3 h-3 sm:w-3.5 sm:h-3.5" style={{ color: '#6B7280' }} />
                    </div>
                    <span className="text-xs sm:text-sm font-semibold text-gray-700">{t.statsReports}</span>
                  </div>
                  <span
                    className="text-[10px] sm:text-xs font-bold px-1.5 sm:px-2 py-0.5 rounded-full"
                    style={{ background: '#F3F4F6', color: '#6B7280' }}
                  >
                    {reportPct}%
                  </span>
                </div>
                <div className="text-3xl sm:text-4xl font-black text-gray-900">
                  {filteredReports.length.toLocaleString('en-IN')}
                </div>
                <div className="text-[10px] sm:text-xs mt-0.5" style={{ color: '#9CA3AF' }}>
                  / {baseReports.length.toLocaleString('en-IN')} {t.statsTotal}
                </div>
                <PillRow filled={reportPills} color={C.dark} />
              </div>

              <div className="rounded-2xl sm:rounded-3xl p-4 sm:p-5" style={{ background: C.lime }}>
                <div className="flex items-center justify-between mb-2 sm:mb-3">
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <div
                      className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg sm:rounded-xl flex items-center justify-center"
                      style={{ background: 'rgba(255,255,255,0.2)' }}
                    >
                      <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                    </div>
                    <span className="text-xs sm:text-sm font-semibold text-white">{t.statsOutreach}</span>
                  </div>
                  <span
                    className="text-[10px] sm:text-xs font-bold px-1.5 sm:px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}
                  >
                    {attachPct}%
                  </span>
                </div>
                <div className="text-3xl sm:text-4xl font-black text-white">
                  {totalOutreach.toLocaleString('en-IN')}
                </div>
                <div className="text-[10px] sm:text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.65)' }}>
                  {t.statsBeneficiaries}
                </div>
                <PillRow filled={Math.min(uniqueStates, 10)} color="rgba(255,255,255,0.4)" />
              </div>

              <div
                className="col-span-2 sm:col-span-1 rounded-2xl sm:rounded-3xl p-4 sm:p-5 flex sm:flex-col items-center sm:items-start justify-between"
                style={{ background: C.dark }}
              >
                <div>
                  <div className="text-[10px] sm:text-xs uppercase tracking-widest font-semibold mb-1 sm:mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>
                    {t.statsAiContent}
                  </div>
                  <div className="text-base sm:text-xl font-black text-white leading-snug">
                    {t.statsTurnData}
                  </div>
                </div>
                <button
                  onClick={() => setActiveTab('content-hub')}
                  className="flex items-center gap-2 sm:mt-5 px-4 py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90 transition shrink-0"
                  style={{ background: C.lime }}
                >
                  <Sparkles className="w-4 h-4" />
                  <span className="hidden xs:inline sm:inline">{t.statsGenerate}</span>
                  <span className="xs:hidden sm:hidden">{t.statsGo}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4 sm:mb-5">
              {[
                { label: t.statsProjects, short: t.statsProjects, value: uniqueProjects },
                { label: t.statsStates,   short: t.statsStates,   value: uniqueStates   },
                { label: t.statsPhotos,   short: t.statsPhotos,   value: withAttachment  },
              ].map(s => (
                <div
                  key={s.label}
                  className="rounded-2xl px-3 sm:px-4 py-3 text-center"
                  style={{ background: 'rgba(255,255,255,0.7)' }}
                >
                  <div className="text-xl sm:text-2xl font-black text-gray-900">{s.value}</div>
                  <div
                    className="text-[9px] sm:text-[10px] uppercase tracking-wide font-semibold mt-0.5"
                    style={{ color: '#9CA3AF' }}
                  >
                    {s.short}
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl sm:rounded-3xl p-4 sm:p-5 mb-4 sm:mb-5 overflow-hidden" style={{ background: C.white }}>
              <div className="flex items-center justify-between mb-3 sm:mb-4 flex-wrap gap-2">
                <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                  <div
                    className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg sm:rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: '#F3F4F6' }}
                  >
                    <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5" style={{ color: '#6B7280' }} />
                  </div>
                  <span className="font-bold text-gray-900 text-sm">{t.activityTitle}</span>
                  <div className="flex items-center gap-2 sm:gap-3 text-[10px] sm:text-xs" style={{ color: '#9CA3AF' }}>
                    <span className="flex items-center gap-1">
                      <span className="inline-block rounded-full shrink-0" style={{ width: 7, height: 7, background: C.dark }} />
                      {t.statsReports}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block rounded-full shrink-0" style={{ width: 7, height: 7, background: C.lime }} />
                      {t.statsOutreach}
                    </span>
                  </div>
                </div>
                <span className="text-[10px] font-semibold" style={{ color: '#9CA3AF' }}>{t.activity14Days}</span>
              </div>
              <ActivityChart data={chartData} />
            </div>
            </>}

            {/* One boundary for all lazy tab bodies so a failed chunk load doesn't
                unmount the app; keyed by tab so switching clears the error. */}
            <ErrorBoundary key={activeTab}>
            <Suspense fallback={<TabLoader />}>
            {activeTab === 'overview' && (
              <OverviewPage
                reports={filteredReports}
                baseReports={baseReports}
                user={user}
                onGenerate={() => setActiveTab('content-hub')}
                onOpenReport={openReport}
              />
            )}
            {activeTab === 'reports' && (
              <ReportCardGrid reports={filteredReports} filters={filters} />
            )}
            {activeTab === 'media' && (
              <MediaLibraryTab reports={filteredReports} />
            )}
            {activeTab === 'impact' && canImpact && (
              <ImpactDashboard
                reports={filteredReports}
                baseReports={baseReports}
                user={user}
                onOpenReport={openReport}
              />
            )}
            {activeTab === 'toc' && canImpact && (
              <TocAnalysisPage baseReports={baseReports} />
            )}
            {activeTab === 'settings' && isAdmin && (
              <ErrorBoundary>
                <SettingsPage />
              </ErrorBoundary>
            )}
            {activeTab === 'analytics' && (
              <WorkerAnalyticsTab baseReports={baseReports} user={user} />
            )}
            {activeTab === 'actionplan' && (
              <ErrorBoundary>
                <ActionPlanTab projectKey={selectedProjectKey ?? undefined} />
              </ErrorBoundary>
            )}
            {activeTab === 'portfolio' && (
              <ErrorBoundary>
                <PortfolioOverviewPage onOpenProject={key => { selectProject(key); setActiveTab('dashboard'); }} />
              </ErrorBoundary>
            )}
            {activeTab === 'orgdash' && canImpact && (
              <ErrorBoundary>
                <OrgDashboardPage onOpenProject={key => { selectProject(key); setActiveTab('dashboard'); }} />
              </ErrorBoundary>
            )}
            {activeTab === 'custom' && (
              <ErrorBoundary>
                <CustomDashboardPage />
              </ErrorBoundary>
            )}
            {activeTab === 'hr' && canSeeTab('hr') && (
              <ErrorBoundary>
                <HrManagementPage />
              </ErrorBoundary>
            )}
            {activeTab === 'forms' && canSeeTab('forms') && (
              <ErrorBoundary>
                <FormsPage />
              </ErrorBoundary>
            )}
            {activeTab === 'financemgmt' && canSeeTab('financemgmt') && (
              <ErrorBoundary>
                <FinanceManagementPage />
              </ErrorBoundary>
            )}
            {activeTab === 'beneficiaryprofile' && canSeeTab('beneficiaryprofile') && (
              <ErrorBoundary>
                <BeneficiaryProfilePage />
              </ErrorBoundary>
            )}
            {/* Project-scoped tabs are keyed by project so switching remounts them
                and no state (or late fetch) from the previous project leaks in. */}
            {activeTab === 'dashboard' && selectedProjectKey && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <ProjectDashboardPage projectKey={selectedProjectKey} />
              </ErrorBoundary>
            )}
            {activeTab === 'vault' && selectedProjectKey && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <DocumentVaultPage projectKey={selectedProjectKey} />
              </ErrorBoundary>
            )}
            {activeTab === 'projectmedia' && selectedProjectKey && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <MediaLibraryTab
                  reports={baseReports.filter(r =>
                    r.project.trim().toLowerCase() === (selectedProject?.name ?? '').trim().toLowerCase()
                  )}
                  projectKey={selectedProjectKey}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'beneficiaries' && canSeeTab('beneficiaries') && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <BeneficiariesPage projectKey={selectedProjectKey ?? undefined} planId={selectedProject?.id} />
              </ErrorBoundary>
            )}
            {activeTab === 'compliance' && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <ComplianceCalendarPage projectKey={selectedProjectKey ?? undefined} />
              </ErrorBoundary>
            )}
            {activeTab === 'financial' && selectedProject && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <BudgetUtilisationPage planId={selectedProject.id} />
              </ErrorBoundary>
            )}
            {activeTab === 'annualprogress' && selectedProject && canImpact && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <AnnualProgressReportPage
                  planId={selectedProject.id}
                  projectName={selectedProject.name}
                  projectKey={selectedProjectKey ?? undefined}
                  region={selectedProject.region}
                  locations={selectedProject.locations}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'mis' && selectedProjectKey && (
              <ErrorBoundary key={`${activeTab}:${selectedProjectKey ?? ''}`}>
                <MisPage projectKey={selectedProjectKey} />
              </ErrorBoundary>
            )}
            {activeTab === 'quickreport' && (
              <ErrorBoundary>
                <QuickReportTab />
              </ErrorBoundary>
            )}
            {activeTab === 'content-hub' && (
              <ErrorBoundary>
                <ContentHubTab
                  user={user}
                  filteredReports={filteredReports}
                  baseReports={baseReports}
                  allReports={reports}
                  filters={filters}
                  onOpenReport={openReport}
                  onOpenSocial={openSocial}
                  onOpenStoryFinder={openStoryFinder}
                  onOpenProjectReportPicker={openProjectReportPicker}
                  onOpenCaseStudyPicker={openCaseStudyPicker}
                  onOpenOrgReportPicker={openOrgReportPicker}
                  onOpenSelfReportPicker={openSelfReportPicker}
                  onOpenTeamReportPicker={openTeamReportPicker}
                  onOpenImpactReportPicker={openImpactReportPicker}
                  onOpenContentPicker={openContentPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'generate-report' && reportConfig && (
              <ErrorBoundary>
                <GenerateReportPage
                  reports={reportConfig.reports}
                  userName={user?.name ?? 'Field Worker'}
                  title={reportConfig.title}
                  customInstruction={reportConfig.instruction}
                  filters={reportConfig.filters ?? filters}
                  subjects={reportConfig.subjects}
                  kind={reportConfig.kind}
                  availableContributors={availableContributors}
                  pendingSubjectPick={reportConfig.pendingSubjectPick}
                  initialLanguage={reportConfig.language}
                  onClose={closeReport}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'story-finder' && (
              <ErrorBoundary>
                <StoryFinderView
                  reports={filteredReports}
                  userName={user?.name ?? 'Field Worker'}
                  filters={filters}
                  onClose={closeStoryFinder}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'project-report-picker' && projectReportPickerConfig && (
              <ErrorBoundary>
                <ProjectReportPickerView
                  baseReports={baseReports}
                  reportTitle={projectReportPickerConfig.title}
                  instruction={projectReportPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeProjectReportPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'case-study-picker' && caseStudyPickerConfig && (
              <ErrorBoundary>
                <CaseStudyPickerView
                  baseReports={baseReports}
                  reportTitle={caseStudyPickerConfig.title}
                  instruction={caseStudyPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeCaseStudyPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'org-report-picker' && orgReportPickerConfig && (
              <ErrorBoundary>
                <OrgReportPickerView
                  baseReports={baseReports}
                  reportTitle={orgReportPickerConfig.title}
                  instruction={orgReportPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeOrgReportPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'self-report-picker' && selfReportPickerConfig && (
              <ErrorBoundary>
                <SelfReportPickerView
                  selfReports={selfReports}
                  reportTitle={selfReportPickerConfig.title}
                  instruction={selfReportPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeSelfReportPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'team-report-picker' && teamReportPickerConfig && (
              <ErrorBoundary>
                <TeamReportPickerView
                  teamReports={teamReports}
                  reportTitle={teamReportPickerConfig.title}
                  instruction={teamReportPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeTeamReportPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'impact-report-picker' && impactReportPickerConfig && (
              <ErrorBoundary>
                <ImpactReportPickerView
                  baseReports={baseReports}
                  reportTitle={impactReportPickerConfig.title}
                  instruction={impactReportPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeImpactReportPicker}
                />
              </ErrorBoundary>
            )}
            {activeTab === 'content-picker' && contentPickerConfig && (
              <ErrorBoundary>
                <ContentPickerView
                  baseReports={baseReports}
                  reportTitle={contentPickerConfig.title}
                  instruction={contentPickerConfig.instruction}
                  onOpenReport={openReport}
                  onClose={closeContentPicker}
                />
              </ErrorBoundary>
            )}
            </Suspense>
            </ErrorBoundary>
            </>}
          </div>
        </div>
      </div>

      {/* Modals */}
      {socialConfig && (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <SocialPostModal
              reports={socialConfig.reports}
              scope={socialConfig.scope}
              scopeName={socialConfig.scopeName}
              defaultPlatform={socialConfig.platform as any}
              onClose={() => setSocialConfig(null)}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* A failed overlay chunk is just left out. The empty fragment matters:
          ErrorBoundary treats a falsy fallback as "show the default error modal". */}
      <ErrorBoundary fallback={<></>}>
        <Suspense fallback={null}>
          <UserProfileModal open={showProfile} onClose={() => setShowProfile(false)} />

          <AIAssistantPanel />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
