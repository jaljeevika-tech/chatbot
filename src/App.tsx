import { useState, useEffect, Suspense } from 'react';
import { OrgProvider, useOrg } from './context/OrgContext';
import { AuthProvider, useAuthContext } from './context/AuthContext';
import { ReportProvider } from './context/ReportContext';
import { ProjectProvider } from './context/ProjectContext';
import { LanguageProvider } from './context/LanguageContext';
import { ToastProvider } from './context/ToastContext';
import { ToastStack } from './components/ui/ToastStack';
import { BootSplash } from './components/ui/BootSplash';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LandingPage } from './components/LandingPage';
import { LoginPage } from './components/login/LoginPage';
import { DEFAULT_TAB, preloadTab, tabFromHash } from './components/dashboard/dashboardTabs';
import { lazyNamed } from './utils/lazyNamed';
import { isOrgAppPath } from './components/org-app/orgAppRoute';

// Landing + Login stay in the boot bundle; everything behind login is its own chunk.
const loadDashboard = () => import('./components/dashboard/DashboardPage');
const DashboardPage                = lazyNamed(loadDashboard, 'DashboardPage');
const BeneficiaryPublicProfilePage = lazyNamed(() => import('./components/dashboard/BeneficiaryPublicProfilePage'), 'BeneficiaryPublicProfilePage');
const FinancePage                  = lazyNamed(() => import('./components/finance/FinancePage'), 'FinancePage');
const SuperAdminPage               = lazyNamed(() => import('./components/superadmin/SuperAdminPage'), 'SuperAdminPage');
const PrivacyPolicyPage            = lazyNamed(() => import('./components/PrivacyPolicyPage'), 'PrivacyPolicyPage');
const OrgSwitchPrompt              = lazyNamed(() => import('./components/login/OrgSwitchPrompt'), 'OrgSwitchPrompt');
const SetPasswordPage              = lazyNamed(() => import('./components/login/SetPasswordPage'), 'SetPasswordPage');
const loadOrgApp = () => import('./components/org-app/OrgApp');
const OrgApp                       = lazyNamed(loadOrgApp, 'OrgApp');

// Beneficiary QR target: a plain `/beneficiary/<uid>` path, not a #hash route, so it works
// as an ordinary link. Read straight off the pathname since nothing navigates client-side.
function beneficiaryUidFromPath(pathname: string): string | null {
  const match = /^\/beneficiary\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function AppRouter() {
  const { user, firebaseUser, authReady, logout } = useAuthContext();
  const { org, orgSlug, isModule } = useOrg();
  // ?org=<slug> from a shared login link. Only the sign-in form reads it, so an
  // existing session for another org must not silently win (see OrgSwitchPrompt).
  const [linkSlug, setLinkSlug] = useState(() => new URLSearchParams(window.location.search).get('org'));
  const [showLogin, setShowLogin] = useState(false);
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const beneficiaryUid = beneficiaryUidFromPath(window.location.pathname);
  // FieldFlow Org: the HR + Finance phone app (components/org-app).
  const orgApp = isOrgAppPath(window.location.pathname);
  // The super admin console deep-links its pages: #superadmin/orgs/<id>/users etc.
  const superadminHash = hash === '#superadmin' || hash.startsWith('#superadmin/');

  // Once Firebase reports a persisted session, prefetch the dashboard chunk and its
  // starting tab in parallel with the claims check and org metadata fetch.
  const headedToDashboard = !!firebaseUser && !beneficiaryUid && !orgApp
    && !superadminHash && hash !== '#jems-finance'
    && window.location.pathname !== '/privacy' && window.location.pathname !== '/set-password';
  useEffect(() => {
    if (!headedToDashboard) return;
    loadDashboard().catch(() => {});
    preloadTab(tabFromHash() ?? DEFAULT_TAB);
  }, [headedToDashboard]);
  useEffect(() => {
    if (firebaseUser && orgApp) loadOrgApp().catch(() => {});
  }, [firebaseUser, orgApp]);

  // Public, checked before every auth-gated branch: a privacy notice must be readable without an account.
  if (window.location.pathname === '/privacy') {
    return <PrivacyPolicyPage />;
  }

  // Invite / password-reset link from an email — public, the token is the credential.
  if (window.location.pathname === '/set-password') {
    return <SetPasswordPage />;
  }

  // Hold a splash while the persisted session resolves, rather than flashing the landing page.
  if (!authReady) return <BootSplash />;

  if (user && org && orgSlug && linkSlug && !superadminHash && linkSlug.toLowerCase() !== orgSlug.toLowerCase()) {
    return (
      <OrgSwitchPrompt
        currentOrgName={org.branding?.org_name || orgSlug}
        linkSlug={linkSlug}
        onSwitch={logout}
        onStay={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('org');
          window.history.replaceState(null, '', url.pathname + url.search + url.hash);
          setLinkSlug(null);
        }}
      />
    );
  }

  // The phone app opens straight on its login form — no marketing page.
  if (orgApp) return user && org ? <OrgApp /> : <LoginPage />;

  // Beneficiary QR page takes priority once logged in; when signed out the path survives
  // the login flow, so login lands here afterwards.
  if (user && org && beneficiaryUid) {
    return <BeneficiaryPublicProfilePage uid={beneficiaryUid} />;
  }

  if (user && user.role === 'superadmin' && superadminHash) {
    return <SuperAdminPage />;
  }

  // Finance route, only when the module is enabled for this org
  if (user && org && isModule('finance') && hash === '#jems-finance') {
    return <FinancePage />;
  }

  if (user && org) return <DashboardPage />;
  if (showLogin) return <LoginPage />;
  return <LandingPage onLogin={() => setShowLogin(true)} />;
}

export default function App() {
  return (
    <OrgProvider>
      <LanguageProvider>
        <ToastProvider>
          <AuthProvider>
            <ReportProvider>
              <ProjectProvider>
                {/* A chunk that fails to load (network drop) shows a Reload prompt, not a blank screen */}
                <ErrorBoundary fallback={<BootSplash failed />}>
                  <Suspense fallback={<BootSplash />}>
                    <AppRouter />
                  </Suspense>
                </ErrorBoundary>
                <ToastStack />
              </ProjectProvider>
            </ReportProvider>
          </AuthProvider>
        </ToastProvider>
      </LanguageProvider>
    </OrgProvider>
  );
}
