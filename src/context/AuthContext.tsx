import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithCustomToken,
  signOut,
  onIdTokenChanged,
  setPersistence,
  browserLocalPersistence,
  type User,
} from 'firebase/auth';
import { useOrg, type OrgPayload } from './OrgContext';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const firebaseApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const firebaseAuth = getAuth(firebaseApp);
// Persist auth across tabs and refreshes
setPersistence(firebaseAuth, browserLocalPersistence).catch(() => {});

// Per-org browser keys (not namespaced by org), cleared on logout. UI-only prefs are kept.
const TENANT_LOCAL_KEYS = ['ff_selected_project_key', 'quickReport.draft.text', 'actionPlan.activeKey', 'ff_offline_session']
const TENANT_LOCAL_PREFIXES = ['actionPlan.bulk.']
function clearTenantLocalState() {
  try {
    for (const k of TENANT_LOCAL_KEYS) localStorage.removeItem(k);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && TENANT_LOCAL_PREFIXES.some(p => k.startsWith(p))) localStorage.removeItem(k);
    }
    sessionStorage.clear();
  } catch { /* storage blocked — nothing to clear */ }
}

// Offline start (HR tab): the signed-in user + secret-stripped org metadata are kept
// per Firebase uid so the HR tab can run from its device cache. Removed on logout.
const OFFLINE_SESSION_KEY = 'ff_offline_session'
interface OfflineSession { uid: string; user: AuthUser; org: OrgPayload }

function saveOfflineSession(session: OfflineSession) {
  try { localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(session)); } catch { /* storage full/blocked */ }
}
function readOfflineSession(uid: string): OfflineSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(OFFLINE_SESSION_KEY) || 'null') as OfflineSession | null;
    return s?.uid === uid ? s : null;
  } catch { return null; }
}
/** No connection, as opposed to the server rejecting us. */
function isNetworkError(e: unknown): boolean {
  return !navigator.onLine
    || e instanceof TypeError   // fetch() failing to connect
    || (e as { code?: string })?.code === 'auth/network-request-failed';
}

export type UserRole = 'superadmin' | 'admin' | 'manager' | 'employee';

export interface AuthUser {
  uid:   string;
  phone: string;
  name:  string;
  role:  UserRole;
  orgId: string;
}

interface AuthContextValue {
  user:         AuthUser | null;
  firebaseUser: User | null;
  /** False until Firebase reports the persisted session (and its org loads), so the app
   *  shows a splash instead of flashing the landing page at a signed-in user. */
  authReady:    boolean;
  /** Started without a network on the saved session; only the HR tab works until it returns. */
  offlineSession: boolean;
  login:        (phone: string, password: string) => Promise<void>;
  logout:       () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { loadOrg, restoreOrg, clearOrg } = useOrg();
  const [user, setUser]       = useState<AuthUser | null>(null);
  const [firebaseUser, setFb] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [offlineSession, setOfflineSession] = useState(false);
  const userRef = useRef<AuthUser | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  useEffect(() => {
    // Never hold the splash longer than this if the org fetch hangs.
    const splashTimeout = setTimeout(() => setAuthReady(true), 10_000);
    const unsub = onIdTokenChanged(firebaseAuth, async (fbUser) => {
      setFb(fbUser);
      try {
        if (!fbUser) { setUser(null); clearOrg(); return; }
        const tokenResult = await fbUser.getIdTokenResult();
        const claims = tokenResult.claims;
        // Custom claims not propagated yet; wait for the next token rotation
        if (!claims.orgId) return;
        const org = await loadOrg(tokenResult.token);
        const authUser: AuthUser = {
          uid:   fbUser.uid,
          phone: (claims.phone as string) || '',
          name:  (claims.name  as string) || '',
          role:  (claims.role  as UserRole) || 'employee',
          orgId: (claims.orgId as string) || '',
        };
        setUser(authUser);
        setOfflineSession(false);
        saveOfflineSession({ uid: fbUser.uid, user: authUser, org });
      } catch (e) {
        // No network is not a bad session, so never sign out for it: at startup run from the
        // saved session if one exists; mid-session (a token refresh blip) carry on.
        if (fbUser && isNetworkError(e)) {
          const saved = userRef.current ? null : readOfflineSession(fbUser.uid);
          if (saved) {
            restoreOrg(saved.org);
            setUser(saved.user);
            setOfflineSession(true);
          }
          return;
        }
        await signOut(firebaseAuth);
      } finally {
        setAuthReady(true);
      }
    });
    // Back online after an offline start: a forced token refresh re-runs the normal boot.
    const onOnline = () => { firebaseAuth.currentUser?.getIdToken(true).catch(() => {}); };
    window.addEventListener('online', onOnline);
    return () => { clearTimeout(splashTimeout); unsub(); window.removeEventListener('online', onOnline); };
  }, [loadOrg, restoreOrg, clearOrg]);

  const login = useCallback(async (phone: string, password: string) => {
    const orgSlug = new URLSearchParams(window.location.search).get('org');
    // No tenant guessing: a password checked against the wrong org's users just fails confusingly.
    if (!orgSlug) throw new Error('No organization specified — use your organization\'s login link (it includes ?org=... in the URL).')
    const res = await fetch('/api/auth/sheet-login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phone, password, orgSlug }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    const cred = await signInWithCustomToken(firebaseAuth, data.customToken);
    // Force refresh so custom claims (orgId, role, name) are in the ID token
    await cred.user.getIdToken(true);
  }, []);

  const logout = useCallback(async () => {
    await signOut(firebaseAuth);
    clearOrg();
    clearTenantLocalState();
    // Clears offline HR data; the outbox (unsynced work) is kept and syncs on next sign-in.
    await import('../utils/hr/hrStore').then(m => m.kvClearAll()).catch(() => {});
    // Full reload: React state still holds the previous org's data, and on a shared field
    // laptop the next user could otherwise see it.
    window.location.reload();
  }, [clearOrg]);

  return (
    <AuthContext.Provider value={{ user, firebaseUser, authReady, offlineSession, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be inside AuthProvider');
  return ctx;
}

export { firebaseAuth };
