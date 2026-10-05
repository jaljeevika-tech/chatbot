/** Per-project summary cards: reports, beneficiaries, states, last activity; top project highlighted. */

import { useMemo } from 'react';
import type { DailyReport } from '../../types/report';

const C = {
  dark:    '#0E3A46',
  lime:    '#16a34a',   // green — beneficiary/impact accent
  muted:   '#86A0A5',
  surface: '#FBF9F4',
  faint:   'rgba(251,249,244,0.7)',
};

interface ProjectSummary {
  name: string;
  reportCount: number;
  totalBeneficiaries: number;
  stateCount: number;
  lastDate: string;
  shareOfTotal: number;
}

interface Props {
  reports: DailyReport[];
}

export function ProjectPerformanceGrid({ reports }: Props) {
  const projects: ProjectSummary[] = useMemo(() => {
    const m = new Map<string, {
      count: number; benef: number; states: Set<string>; lastDate: string;
    }>();
    reports.forEach(r => {
      if (!r.project) return;
      const cur = m.get(r.project) ?? { count: 0, benef: 0, states: new Set<string>(), lastDate: '' };
      const ds = String(r.timestamp).slice(0, 10);
      m.set(r.project, {
        count:    cur.count + 1,
        benef:    cur.benef + (parseInt(String(r.beneficiaries ?? 0)) || 0),
        states:   new Set([...cur.states, ...(r.state ? [r.state] : [])]),
        lastDate: ds > cur.lastDate ? ds : cur.lastDate,
      });
    });
    const total = Math.max(reports.length, 1);
    return [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([name, d]) => ({
        name,
        reportCount:        d.count,
        totalBeneficiaries: d.benef,
        stateCount:         d.states.size,
        lastDate:           d.lastDate,
        shareOfTotal:       Math.round((d.count / total) * 100),
      }));
  }, [reports]);

  if (projects.length === 0) {
    return <p className="text-xs text-gray-400">No project data.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-2 overflow-y-auto" style={{ maxHeight: 320 }}>
      {projects.map((p, i) => {
        const isDark = i === 0;
        return (
          <div
            key={p.name}
            className="rounded-xl p-3"
            style={{ background: isDark ? C.dark : C.faint }}
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div
                className="text-xs font-bold truncate leading-snug"
                style={{ color: isDark ? '#FFFFFF' : '#111827' }}
                title={p.name}
              >
                {p.name}
              </div>
              <span
                className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                style={{
                  background: isDark ? 'rgba(255,255,255,0.12)' : C.surface,
                  color:      isDark ? '#D4CAFE' : '#5A2D9E',
                }}
              >
                {p.shareOfTotal}%
              </span>
            </div>

            <div className="grid grid-cols-3 gap-1 text-center">
              <div>
                <div className="text-sm font-black"
                  style={{ color: isDark ? '#FFFFFF' : '#111827' }}>
                  {p.reportCount}
                </div>
                <div className="text-[9px] uppercase tracking-wide font-semibold"
                  style={{ color: isDark ? 'rgba(255,255,255,0.45)' : C.muted }}>
                  Reports
                </div>
              </div>
              <div>
                <div className="text-sm font-black"
                  style={{ color: isDark ? C.lime : '#341272' }}>
                  {p.totalBeneficiaries > 999
                    ? `${(p.totalBeneficiaries / 1000).toFixed(1)}k`
                    : p.totalBeneficiaries.toLocaleString('en-IN')}
                </div>
                <div className="text-[9px] uppercase tracking-wide font-semibold"
                  style={{ color: isDark ? 'rgba(255,255,255,0.45)' : C.muted }}>
                  Reached
                </div>
              </div>
              <div>
                <div className="text-sm font-black"
                  style={{ color: isDark ? '#FFFFFF' : '#111827' }}>
                  {p.stateCount}
                </div>
                <div className="text-[9px] uppercase tracking-wide font-semibold"
                  style={{ color: isDark ? 'rgba(255,255,255,0.45)' : C.muted }}>
                  States
                </div>
              </div>
            </div>

            <div className="mt-1.5 text-[9px] font-semibold"
              style={{ color: isDark ? 'rgba(255,255,255,0.3)' : C.muted }}>
              Last: {p.lastDate || 'N/A'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
