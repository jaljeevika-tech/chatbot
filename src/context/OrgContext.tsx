import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { OrgMetadata, OrgSubscription } from '../types/org';

interface OrgContextValue {
  org:           OrgMetadata | null;
  orgId:         string | null;
  /** The org's login slug — the `?org=` in its login link. */
  orgSlug:       string | null;
  firebaseToken: string | null;
  subscription:  OrgSubscription | null;
  hasAI:         boolean;
  /** Fetches and applies the org; resolves with the payload so AuthContext
   *  can keep a copy for starting up offline. */
  loadOrg:       (token: string) => Promise<OrgPayload>;
  /** Applies a saved payload without a network round-trip (offline start). */
  restoreOrg:    (data: OrgPayload) => void;
  clearOrg:      () => void;
  isModule:      (key: keyof OrgMetadata['modules']) => boolean;
}

export interface OrgPayload { orgId: string; slug?: string; metadata: OrgMetadata; subscription?: OrgSubscription }

const OrgContext = createContext<OrgContextValue | null>(null);

const CSS_VAR_MAP: Record<string, string> = {
  primary:    '--color-primary',
  sidebar:    '--color-sidebar',
  accent:     '--color-accent',
  background: '--color-background',
};

function applyTheme(theme: OrgMetadata['branding']['theme']) {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    const value = theme[key as keyof typeof theme];
    if (value) root.style.setProperty(cssVar, value);
  }
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const [org, setOrg]                     = useState<OrgMetadata | null>(null);
  const [orgId, setOrgId]                 = useState<string | null>(null);
  const [orgSlug, setOrgSlug]             = useState<string | null>(null);
  const [firebaseToken, setToken]         = useState<string | null>(() =>
    sessionStorage.getItem('ff_token')
  );
  const [subscription, setSubscription]   = useState<OrgSubscription | null>(null);

  const restoreOrg = useCallback((data: OrgPayload) => {
    setOrgId(data.orgId);
    setOrgSlug(data.slug ?? null);
    setOrg(data.metadata);
    setSubscription(data.subscription ?? null);
    applyTheme(data.metadata.branding.theme);

    document.title = data.metadata.branding.dashboard_title || data.metadata.branding.org_name;
  }, []);

  const loadOrg = useCallback(async (token: string) => {
    const res = await fetch('/api/org/metadata', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Failed to load org' }));
      throw new Error(error);
    }

    const data: OrgPayload = await res.json();

    sessionStorage.setItem('ff_token', token);
    setToken(token);
    restoreOrg(data);
    return data;
  }, [restoreOrg]);

  const clearOrg = useCallback(() => {
    sessionStorage.removeItem('ff_token');
    setToken(null);
    setOrgId(null);
    setOrgSlug(null);
    setOrg(null);
    setSubscription(null);
  }, []);

  const isModule = useCallback(
    (key: keyof OrgMetadata['modules']) => org?.modules?.[key]?.enabled ?? false,
    [org]
  );

  // Mirrors the server's subscriptionGuard: AI pauses in read-only, keeps working in grace.
  const hasAI = (
    subscription?.plan?.ai_enabled === true &&
    subscription?.access?.state !== 'read_only' &&
    (subscription?.status === 'active' || subscription?.status === 'trialing' || subscription?.access?.state === 'grace')
  );

  return (
    <OrgContext.Provider value={{ org, orgId, orgSlug, firebaseToken, subscription, hasAI, loadOrg, restoreOrg, clearOrg, isModule }}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be inside OrgProvider');
  return ctx;
}
