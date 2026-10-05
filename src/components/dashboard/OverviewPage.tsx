// Analytics overview: operational KPIs, outcomes, data quality and a 6-month trend.

import { useMemo } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import {
  FileText, TrendingUp, MapPin, Users, Camera,
  Activity, Briefcase, Calendar, Zap, ShieldCheck,
} from 'lucide-react';
import type { DailyReport } from '../../types/report';
import type { AuthUser } from '../../context/AuthContext';
import { MonthlyChart } from './MonthlyChart';
import { localIsoDate } from '../../utils/format';
import { ProjectPerformanceGrid } from './ProjectPerformanceGrid';

// Design tokens (see theme/colors.ts FF)
const C = {
  bg:      '#F2F7F8',
  lime:    '#16a34a',   // green — beneficiary/impact accent (kept distinct)
  dark:    '#0E3A46',   // FF.tealDark
  white:   '#FFFFFF',
  pill:    '#DDD6FE',   // light violet pills
  muted:   '#9CA3AF',
  surface: '#FBF9F4',   // FF.bgWarm
  faint:   '#D9E6E8',   // FF.border
};

// ── Pill-row progress ─────────────────────────────────────────────────────────
function PillRow({ filled, total = 10, color = C.dark }: {
  filled: number; total?: number; color?: string;
}) {
  const f = Math.min(Math.max(Math.round(filled), 0), total);
  return (
    <div className="flex gap-1 flex-wrap mt-3">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          width: 20, height: 10, borderRadius: 999,
          background: i < f ? color : C.pill,
          transition: 'background 0.3s',
        }} />
      ))}
    </div>
  );
}

// ── Dual pill-bar activity chart ──────────────────────────────────────────────
function ActivityChart({ data }: {
  data: { label: string; reports: number; outreach: number }[];
}) {
  const maxR = Math.max(...data.map(d => d.reports), 1);
  const maxO = Math.max(...data.map(d => d.outreach), 1);
  return (
    <div className="flex items-end gap-1.5" style={{ height: 132 }}>
      {data.map((day, i) => {
        const rh = Math.max((day.reports / maxR) * 106, day.reports > 0 ? 8 : 3);
        const oh = Math.max((day.outreach / maxO) * 106, day.outreach > 0 ? 8 : 3);
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5"
            title={`${day.label}: ${day.reports} reports · ${day.outreach.toLocaleString('en-IN')} outreach`}>
            <div className="flex items-end gap-[3px]" style={{ height: 112 }}>
              <div style={{ width: 7, height: rh, borderRadius: 999, background: C.dark, transition: 'height .5s' }} />
              <div style={{ width: 7, height: oh, borderRadius: 999, background: C.lime, transition: 'height .5s' }} />
            </div>
            <div style={{ fontSize: 8, color: C.muted, whiteSpace: 'nowrap' }}>{day.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Horizontal bar row ────────────────────────────────────────────────────────
function HBar({ label, value, max, color = C.dark, badge }: {
  label: string; value: number; max: number; color?: string; badge?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-gray-700 truncate" style={{ maxWidth: '65%' }}>{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
              style={{ background: '#DCFCE7', color: '#15803d' }}>{badge}</span>
          )}
          <span className="text-xs font-black text-gray-900">{value}</span>
        </div>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: '#E8E0F8' }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-3xl p-5 ${className}`} style={{ background: C.white }}>
      {children}
    </div>
  );
}

function CardHead({ icon: Icon, title, right }: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-xl flex items-center justify-center" style={{ background: C.surface }}>
          <Icon className="w-3.5 h-3.5" style={{ color: '#6B7280' }} />
        </div>
        <span className="font-bold text-gray-900 text-sm">{title}</span>
      </div>
      {right && <div className="text-xs" style={{ color: C.muted }}>{right}</div>}
    </div>
  );
}

function MiniStat({ emoji, label, value, trend }: {
  emoji: string; label: string; value: number | string; trend?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl p-3 text-center" style={{ background: C.faint }}>
      <div className="text-lg">{emoji}</div>
      <div className="text-xl font-black text-gray-900 mt-0.5">
        {typeof value === 'number' ? value.toLocaleString('en-IN') : value}
      </div>
      {trend && <div className="flex justify-center mt-1">{trend}</div>}
      <div className="text-[10px] uppercase tracking-wide font-semibold mt-0.5" style={{ color: C.muted }}>
        {label}
      </div>
    </div>
  );
}

function TrendBadge({ current, prev }: { current: number; prev: number }) {
  if (prev === 0 && current === 0) return null;
  if (prev === 0) return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
      style={{ background: '#D1FAE5', color: '#065F46' }}>NEW</span>
  );
  const pct = Math.round(((current - prev) / prev) * 100);
  const neutral = pct === 0;
  const up = pct > 0;
  const bg    = neutral ? '#F3F4F6' : up ? '#D1FAE5' : '#FEE2E2';
  const color = neutral ? '#6B7280' : up ? '#065F46' : '#991B1B';
  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: bg, color }}>
      {neutral ? '→' : up ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  );
}

function QualityBar({ label, pct, description }: {
  label: string; pct: number; description: string;
}) {
  const barColor = pct >= 80 ? '#059669' : pct >= 50 ? '#D97706' : '#DC2626';
  const badgeBg  = pct >= 80 ? '#D1FAE5' : pct >= 50 ? '#FEF3C7' : '#FEE2E2';
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-gray-700">{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px]" style={{ color: C.muted }}>{description}</span>
          <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full"
            style={{ background: badgeBg, color: barColor }}>{pct}%</span>
        </div>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: '#E8E0F8' }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: barColor }} />
      </div>
    </div>
  );
}

interface Props {
  reports: DailyReport[];
  baseReports: DailyReport[];
  user: AuthUser | null;
  onGenerate: () => void;
  onOpenReport?: (title: string, data: DailyReport[]) => void;
}

export function OverviewPage({ reports, baseReports, user, onGenerate }: Props) {
  const { t } = useLanguage();

  const totalOutreach  = useMemo(() =>
    reports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0), [reports]);
  const uniqueProjects = useMemo(() => new Set(reports.map(r => r.project).filter(Boolean)).size, [reports]);
  const uniqueStates   = useMemo(() => new Set(reports.map(r => r.state).filter(Boolean)).size, [reports]);
  const contributors   = useMemo(() => new Set(reports.map(r => r.name).filter(Boolean)).size, [reports]);
  const withPhoto      = useMemo(() => reports.filter(r => r.attachmentUrl).length, [reports]);
  const totalBase      = Math.max(baseReports.length, 1);
  const reportPct      = Math.round((reports.length / totalBase) * 100);
  const reportPills    = Math.round((reports.length / totalBase) * 10);

  const thisWeekCut = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return localIsoDate(d);
  }, []);
  const thisWeek = useMemo(() =>
    reports.filter(r => String(r.timestamp).slice(0, 10) >= thisWeekCut).length,
    [reports, thisWeekCut]);

  // Previous week, for week-over-week trends
  const prevWeekCut = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 14);
    return localIsoDate(d);
  }, []);
  const prevWeekReports = useMemo(() =>
    reports.filter(r => {
      const ds = String(r.timestamp).slice(0, 10);
      return ds >= prevWeekCut && ds < thisWeekCut;
    }),
    [reports, prevWeekCut, thisWeekCut]);

  const prevWeekOutreach = useMemo(() =>
    prevWeekReports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0),
    [prevWeekReports]);
  const prevWeekContributors = useMemo(() =>
    new Set(prevWeekReports.map(r => r.name).filter(Boolean)).size, [prevWeekReports]);
  const prevWeekPhotos = useMemo(() =>
    prevWeekReports.filter(r => r.attachmentUrl).length, [prevWeekReports]);
  const prevWeekStates = useMemo(() =>
    new Set(prevWeekReports.map(r => r.state).filter(Boolean)).size, [prevWeekReports]);

  const thisWeekOutreach = useMemo(() =>
    reports.filter(r => String(r.timestamp).slice(0, 10) >= thisWeekCut)
      .reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0),
    [reports, thisWeekCut]);
  const thisWeekContributors = useMemo(() =>
    new Set(reports.filter(r => String(r.timestamp).slice(0, 10) >= thisWeekCut)
      .map(r => r.name).filter(Boolean)).size, [reports, thisWeekCut]);
  const thisWeekPhotos = useMemo(() =>
    reports.filter(r => String(r.timestamp).slice(0, 10) >= thisWeekCut && r.attachmentUrl).length,
    [reports, thisWeekCut]);
  const thisWeekStates = useMemo(() =>
    new Set(reports.filter(r => String(r.timestamp).slice(0, 10) >= thisWeekCut)
      .map(r => r.state).filter(Boolean)).size, [reports, thisWeekCut]);

  const chartData = useMemo(() =>
    Array.from({ length: 14 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (13 - i));
      const ds = localIsoDate(d);
      const day = reports.filter(r => String(r.timestamp).slice(0, 10) === ds);
      return {
        label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
        reports: day.length,
        outreach: day.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0),
      };
    }), [reports]);

  const projectRows = useMemo(() => {
    const m = new Map<string, number>();
    reports.forEach(r => r.project && m.set(r.project, (m.get(r.project) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [reports]);

  const stateRows = useMemo(() => {
    const m = new Map<string, number>();
    reports.forEach(r => r.state && m.set(r.state, (m.get(r.state) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [reports]);

  const areaRows = useMemo(() => {
    const m = new Map<string, number>();
    reports.forEach(r => r.areaOfIntervention && m.set(r.areaOfIntervention, (m.get(r.areaOfIntervention) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [reports]);

  const dataCollectionRate = useMemo(() => {
    if (reports.length === 0) return 0;
    const dates = reports.map(r => String(r.timestamp).slice(0, 10)).filter(Boolean).sort();
    if (dates.length === 0) return 0;
    const totalDays = Math.max(
      Math.round((Date.now() - new Date(dates[0]).getTime()) / 86400000) + 1, 1
    );
    return Math.round((new Set(dates).size / totalDays) * 100);
  }, [reports]);

  const avgBenefPerReport = useMemo(() =>
    reports.length === 0 ? 0 : Math.round(totalOutreach / reports.length),
    [reports, totalOutreach]);

  const activeContribRate = useMemo(() => {
    const known = new Set(baseReports.map(r => r.name).filter(Boolean));
    if (known.size === 0) return 0;
    const cut = new Date(); cut.setDate(cut.getDate() - 14);
    const cutStr = localIsoDate(cut);
    const recent = new Set(
      reports.filter(r => String(r.timestamp).slice(0, 10) >= cutStr)
        .map(r => r.name).filter(Boolean)
    );
    return Math.round((recent.size / known.size) * 100);
  }, [reports, baseReports]);

  const photoQualityPct = useMemo(() =>
    reports.length === 0 ? 0 : Math.round((withPhoto / reports.length) * 100),
    [reports, withPhoto]);

  const descCompletePct = useMemo(() => {
    if (reports.length === 0) return 0;
    const complete = reports.filter(r => (r.description ?? '').trim().length >= 30).length;
    return Math.round((complete / reports.length) * 100);
  }, [reports]);

  const contributorConsistencyPct = useMemo(() => {
    const cur  = new Set(reports.filter(r => String(r.timestamp).slice(0, 10) >= thisWeekCut)
      .map(r => r.name).filter(Boolean));
    const prev = new Set(prevWeekReports.map(r => r.name).filter(Boolean));
    const union = new Set([...cur, ...prev]);
    if (union.size === 0) return 0;
    const intersection = [...cur].filter(n => prev.has(n)).length;
    return Math.round((intersection / union.size) * 100);
  }, [reports, prevWeekReports, thisWeekCut]);

  const contribRows = useMemo(() => {
    if (user?.role === 'employee') return [];
    const m = new Map<string, { count: number; outreach: number; state: string }>();
    reports.forEach(r => {
      if (!r.name) return;
      const cur = m.get(r.name) || { count: 0, outreach: 0, state: '' };
      m.set(r.name, {
        count:    cur.count + 1,
        outreach: cur.outreach + (parseInt(String(r.beneficiaries ?? 0)) || 0),
        state:    cur.state || r.state || '',
      });
    });
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  }, [reports, user?.role]);

  const recent = useMemo(() =>
    [...reports].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 6),
    [reports]);

  const maxState   = stateRows[0]?.[1] || 1;
  const maxArea    = areaRows[0]?.[1] || 1;
  const maxContrib = contribRows[0]?.[1].count || 1;
  const areaColors = ['#15803d', '#1D0752', '#16a34a', '#341272', '#4ade80', '#5A2D9E'];

  return (
    <div className="space-y-4">

      {/* Hero KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

        <div className="rounded-3xl p-5" style={{ background: C.white }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl flex items-center justify-center" style={{ background: C.surface }}>
                <FileText className="w-3.5 h-3.5" style={{ color: '#6B7280' }} />
              </div>
              <span className="text-sm font-semibold text-gray-700">{t.fieldReports}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <TrendBadge current={thisWeek} prev={prevWeekReports.length} />
              <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                style={{ background: C.surface, color: '#6B7280' }}>{reportPct}%</span>
            </div>
          </div>
          <div className="text-4xl font-black text-gray-900">{reports.length.toLocaleString('en-IN')}</div>
          <div className="text-xs mt-0.5" style={{ color: C.muted }}>
            / {baseReports.length.toLocaleString('en-IN')} {t.totalRecords}
          </div>
          <PillRow filled={reportPills} color={C.dark} />
        </div>

        <div className="rounded-3xl p-5" style={{ background: C.lime }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.2)' }}>
                <TrendingUp className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="text-sm font-semibold text-white">{t.outreach}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <TrendBadge current={thisWeekOutreach} prev={prevWeekOutreach} />
              <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white"
                style={{ background: 'rgba(255,255,255,0.2)' }}>{uniqueStates} {t.statesLabel}</span>
            </div>
          </div>
          <div className="text-4xl font-black text-white">{totalOutreach.toLocaleString('en-IN')}</div>
          <div className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.65)' }}>{t.beneficiariesReached}</div>
          <PillRow filled={Math.min(uniqueStates, 10)} color="rgba(255,255,255,0.4)" />
        </div>

        <div className="rounded-3xl p-5 flex flex-col justify-between" style={{ background: C.dark }}>
          <div>
            <div className="text-xs uppercase tracking-widest font-semibold mb-2"
              style={{ color: 'rgba(255,255,255,0.4)' }}>{t.portfolio}</div>
            <div className="text-4xl font-black text-white">{uniqueProjects}</div>
            <div className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
              {t.activeProjects} · {contributors} {t.contributors}
            </div>
          </div>
          <button onClick={onGenerate}
            className="flex items-center gap-2 mt-5 px-4 py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90 transition self-start"
            style={{ background: C.lime }}>
            <Zap className="w-3.5 h-3.5" />
            {t.generateButton}
          </button>
        </div>
      </div>

      {/* Mini-stat strip with week-over-week trends */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniStat emoji="📅" label={t.thisWeek}      value={thisWeek}
          trend={<TrendBadge current={thisWeek} prev={prevWeekReports.length} />} />
        <MiniStat emoji="👥" label={t.contributors}  value={contributors}
          trend={<TrendBadge current={thisWeekContributors} prev={prevWeekContributors} />} />
        <MiniStat emoji="📸" label={t.withPhotos}    value={withPhoto}
          trend={<TrendBadge current={thisWeekPhotos} prev={prevWeekPhotos} />} />
        <MiniStat emoji="📍" label={t.statsStates}   value={uniqueStates}
          trend={<TrendBadge current={thisWeekStates} prev={prevWeekStates} />} />
      </div>

      {/* Operational health */}
      <Card>
        <CardHead icon={Zap} title={t.operationalHealth} right={t.last14Days} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">

          <div className="rounded-2xl p-3 text-center" style={{ background: C.faint }}>
            <div className="text-2xl font-black text-gray-900">{dataCollectionRate}%</div>
            <div className="text-[10px] uppercase tracking-wide font-semibold mt-1" style={{ color: C.muted }}>
              {t.collectionDays}
            </div>
            <div className="text-[9px] mt-0.5" style={{ color: C.muted }}>{t.daysWithReport}</div>
          </div>

          <div className="rounded-2xl p-3 text-center" style={{ background: C.faint }}>
            <div className="text-2xl font-black text-gray-900">
              {avgBenefPerReport.toLocaleString('en-IN')}
            </div>
            <div className="text-[10px] uppercase tracking-wide font-semibold mt-1" style={{ color: C.muted }}>
              {t.avgReport}
            </div>
            <div className="text-[9px] mt-0.5" style={{ color: C.muted }}>{t.beneficiariesPerEntry}</div>
          </div>

          <div className="rounded-2xl p-3 text-center" style={{ background: C.faint }}>
            <div className="text-2xl font-black text-gray-900">{activeContribRate}%</div>
            <div className="text-[10px] uppercase tracking-wide font-semibold mt-1" style={{ color: C.muted }}>
              {t.activeStaff}
            </div>
            <div className="text-[9px] mt-0.5" style={{ color: C.muted }}>{t.ofKnownContributors}</div>
          </div>

          <div className="rounded-2xl p-3 text-center" style={{ background: C.dark }}>
            <div className="text-2xl font-black text-white">
              #{projectRows[0]?.[1] ?? 0}
            </div>
            <div className="text-[10px] uppercase tracking-wide font-semibold mt-1"
              style={{ color: 'rgba(255,255,255,0.5)' }}>{t.topProject}</div>
            <div className="text-[9px] mt-0.5 truncate px-1"
              style={{ color: 'rgba(255,255,255,0.4)' }}
              title={projectRows[0]?.[0] ?? ''}>
              {projectRows[0]?.[0] ?? t.noData}
            </div>
          </div>
        </div>
      </Card>

      {/* 14-day activity trend + program performance */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">

        <Card className="lg:col-span-3">
          <CardHead
            icon={Activity}
            title={t.activityTrend}
            right={
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1">
                  <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: C.dark }} />
                  {t.statsReports}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: C.lime }} />
                  {t.statsOutreach}
                </span>
                <span className="font-semibold">{t.activity14Days}</span>
              </div>
            }
          />
          <ActivityChart data={chartData} />
        </Card>

        <Card className="lg:col-span-2">
          <CardHead icon={Briefcase} title={t.byProject} right={`${projectRows.length} ${t.active}`} />
          <ProjectPerformanceGrid reports={reports} />
        </Card>
      </div>

      {/* 6-month impact timeline */}
      <Card>
        <CardHead
          icon={TrendingUp}
          title={t.monthlyImpact}
          right={
            <div className="flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1">
                <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: C.dark }} />
                {t.statsReports}
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: C.lime }} />
                {t.statsOutreach}
              </span>
              <span className="font-semibold">{t.sixMonths}</span>
            </div>
          }
        />
        <MonthlyChart reports={reports} />
      </Card>

      {/* State coverage + intervention areas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">

        <Card>
          <CardHead icon={MapPin} title={t.stateCoverage} right={`${uniqueStates} ${t.statesLabel}`} />
          {stateRows.map(([state, count], i) => (
            <HBar key={state} label={state} value={count} max={maxState}
              color={i === 0 ? C.lime : i % 2 === 0 ? '#16a34a' : C.dark}
              badge={`${Math.round((count / reports.length) * 100)}%`} />
          ))}
        </Card>

        <Card>
          <CardHead icon={Activity} title={t.interventionAreas} right={`${areaRows.length} ${t.areas}`} />
          {areaRows.length === 0
            ? <p className="text-xs text-gray-400">{t.noData}</p>
            : areaRows.map(([area, count], i) => (
                <HBar key={area} label={area} value={count} max={maxArea}
                  color={areaColors[i] ?? C.dark}
                  badge={`${Math.round((count / reports.length) * 100)}%`} />
              ))
          }
        </Card>
      </div>

      {/* Data quality scorecard */}
      <Card>
        <CardHead icon={ShieldCheck} title={t.dataQuality}
          right={`${reports.length} ${t.reportsAnalysed}`} />
        <QualityBar
          label={t.photoCoverage}
          pct={photoQualityPct}
          description={`${withPhoto} of ${reports.length} ${t.entries}`}
        />
        <QualityBar
          label={t.descriptionCompleteness}
          pct={descCompletePct}
          description={t.thirtyCharDesc}
        />
        <QualityBar
          label={t.contributorConsistency}
          pct={contributorConsistencyPct}
          description={t.weekOverWeek}
        />
      </Card>

      {/* Recent activity */}
      <Card>
        <CardHead icon={Calendar} title={t.recentActivity} right={<span>{t.lastEntries.replace('{n}', String(recent.length))}</span>} />
        <div className="space-y-3">
          {recent.length === 0
            ? <p className="text-xs text-gray-400">{t.noReports}</p>
            : recent.map(r => (
                <div key={r.id} className="flex items-start gap-3 pb-3 last:pb-0"
                  style={{ borderBottom: '1px solid #EDE8F9' }}>
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-base font-black"
                    style={{ background: r.attachmentUrl ? C.lime : C.surface, color: '#111' }}>
                    {r.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-bold text-gray-900">{r.name}</span>
                      {r.state && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                          style={{ background: '#EDE8F9', color: '#5A2D9E' }}>{r.state}</span>
                      )}
                      {r.project && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                          style={{ background: '#EDE8F9', color: '#5A2D9E' }}>{r.project}</span>
                      )}
                      {r.attachmentUrl && (
                        <Camera className="w-3 h-3 shrink-0" style={{ color: C.muted }} />
                      )}
                    </div>
                    <p className="text-[11px] mt-0.5 line-clamp-1" style={{ color: C.muted }}>
                      {r.description}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] font-semibold" style={{ color: C.muted }}>
                      {String(r.timestamp).slice(0, 10)}
                    </div>
                    {r.beneficiaries && Number(r.beneficiaries) > 0 && (
                      <div className="text-[10px] font-bold" style={{ color: C.dark }}>
                        +{Number(r.beneficiaries).toLocaleString('en-IN')}
                      </div>
                    )}
                  </div>
                </div>
              ))
          }
        </div>
      </Card>

      {/* Top contributors (admin/manager only) */}
      {contribRows.length > 0 && (
        <Card>
          <CardHead icon={Users} title={t.topContributors} right={<span>{contribRows.length} {t.shown}</span>} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {contribRows.map(([name, data], i) => (
              <div key={name} className="flex items-center gap-3 p-3 rounded-2xl"
                style={{ background: '#F0EAFE' }}>
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-black shrink-0"
                  style={{ background: i === 0 ? C.lime : i === 1 ? '#DDD6FE' : C.surface, color: '#111' }}>
                  {i < 3 ? ['🥇', '🥈', '🥉'][i] : name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-gray-900 truncate">{name}</div>
                  <div className="text-[10px]" style={{ color: C.muted }}>{data.state}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-black text-gray-900">{data.count}</div>
                  <div className="text-[10px]" style={{ color: C.muted }}>
                    {data.outreach > 0 ? `${data.outreach.toLocaleString('en-IN')} ${t.reached}` : t.reports}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4" style={{ borderTop: '1px solid #EDE8F9' }}>
            <div className="text-[10px] font-black uppercase tracking-widest mb-3" style={{ color: C.muted }}>
              {t.reportVolume}
            </div>
            {contribRows.map(([name, data]) => (
              <HBar key={name} label={name} value={data.count} max={maxContrib} color={C.dark} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
