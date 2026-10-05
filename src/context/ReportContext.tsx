import { createContext, useContext, useState, useEffect, useRef, useMemo, type ReactNode } from 'react';
import type { DailyReport } from '../types/report';
import { fetchReportsFromSheet } from '../utils/googleSheets';
import { fetchUsersFromSheet, type UserRow } from '../utils/authSheet';
import { useOrg } from './OrgContext';
import { apiFetch } from '../utils/apiFetch';

// WhatsApp / Quick Report submissions land in daily_reports; merged with the Sheet rows.
async function fetchReportsFromDb(): Promise<DailyReport[] | null> {
  try {
    const res = await apiFetch('/api/reports/daily');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.reports) ? data.reports : [];
  } catch (err) {
    console.error('Error fetching reports from database:', err);
    return null;
  }
}

interface ReportContextValue {
  reports:         DailyReport[];
  users:           UserRow[];
  loading:         boolean;
  error:           string | null;
  refreshReports:  () => Promise<void>;
  phoneToUser:     Map<string, string>;
  registeredUsers: Map<string, UserRow>;
}

const ReportContext = createContext<ReportContextValue | null>(null);

export function ReportProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [users,   setUsers]   = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Request key for the in-flight fetch, so a slow response for a previous org (superadmin
  // switch) can't overwrite the newly selected org's data.
  const activeSheetIdRef = useRef<string | undefined>(undefined);

  // Last committed data, serialized: the 15s poll usually returns identical rows and a fresh
  // array would re-render every consumer for nothing.
  const lastReportsJsonRef = useRef('');
  const lastUsersJsonRef   = useRef('');
  // Last good rows per source, so a silent poll where one source failed keeps its previous rows.
  const lastPartsRef = useRef<{ sheet: DailyReport[]; db: DailyReport[] }>({ sheet: [], db: [] });

  const loadAll = async (isSilent = false) => {
    // Sheet IDs live in org metadata
    if (!org?.data_sources) return;

    const requestKey = org.data_sources.reports_sheet_id;
    activeSheetIdRef.current = requestKey;

    if (!isSilent) setLoading(true);
    try {
      const [sheetReports, dbReports, userData] = await Promise.all([
        fetchReportsFromSheet(org.data_sources.reports_sheet_id),
        fetchReportsFromDb(),
        fetchUsersFromSheet(org.data_sources.users_sheet_id),
      ]);
      if (activeSheetIdRef.current !== requestKey) return; // stale — org changed mid-fetch
      const prev = isSilent ? lastPartsRef.current : { sheet: [], db: [] };
      const parts = { sheet: sheetReports ?? prev.sheet, db: dbReports ?? prev.db };
      lastPartsRef.current = parts;
      const nextReports = [...parts.db, ...parts.sheet];
      const reportsJson = JSON.stringify(nextReports);
      if (reportsJson !== lastReportsJsonRef.current) {
        lastReportsJsonRef.current = reportsJson;
        setReports(nextReports);
      }
      const usersJson = JSON.stringify(userData ?? []);
      if ((userData || !isSilent) && usersJson !== lastUsersJsonRef.current) {
        lastUsersJsonRef.current = usersJson;
        setUsers(userData ?? []);
      }
      setError(null);
    } catch (err) {
      if (activeSheetIdRef.current !== requestKey) return; // stale
      if (!isSilent) setError('Failed to load data from Google Sheets');
      console.error(err);
    } finally {
      if (activeSheetIdRef.current === requestKey && !isSilent) setLoading(false);
    }
  };

  // Reload when org metadata loads or changes (e.g. superadmin org switch)
  useEffect(() => {
    if (!org) return;
    loadAll();

    const interval = setInterval(() => loadAll(true), 15_000);
    return () => clearInterval(interval);
  }, [org?.data_sources?.reports_sheet_id]);

  const registeredUsers = useMemo(() => new Map<string, UserRow>(users.map(u => [u.phone, u])), [users]);
  const phoneToUser     = useMemo(() => new Map<string, string>(users.map(u => [u.phone, u.name])), [users]);

  // loadAll is recreated each render (it closes over `org`), so refreshReports
  // goes through a ref to keep the context value stable between real changes.
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  const value = useMemo<ReportContextValue>(() => ({
    reports, users, loading, error,
    refreshReports: (isSilent?: boolean) => loadAllRef.current(isSilent),
    phoneToUser, registeredUsers,
  }), [reports, users, loading, error, phoneToUser, registeredUsers]);

  return (
    <ReportContext.Provider value={value}>
      {children}
    </ReportContext.Provider>
  );
}

export function useReportContext() {
  const ctx = useContext(ReportContext);
  if (!ctx) throw new Error('useReportContext must be used within a ReportProvider');
  return ctx;
}
