/** 6-month dual-bar impact trend, plain flex/div bars. */

import type { DailyReport } from '../../types/report';
import { localIsoDate } from '../../utils/format';

const C = {
  dark:  '#0E3A46',
  lime:  '#16a34a',   // green — beneficiary/impact accent
  muted: '#86A0A5',
};

interface MonthBucket {
  label: string;
  reports: number;
  outreach: number;
}

interface Props {
  reports: DailyReport[];
}

export function MonthlyChart({ reports }: Props) {
  const buckets: MonthBucket[] = Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - (5 - i));
    const key = localIsoDate(d).slice(0, 7); // "YYYY-MM"
    const inMonth = reports.filter(r => String(r.timestamp).slice(0, 7) === key);
    return {
      label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
      reports: inMonth.length,
      outreach: inMonth.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0),
    };
  });

  const maxR = Math.max(...buckets.map(b => b.reports), 1);
  const maxO = Math.max(...buckets.map(b => b.outreach), 1);
  const chartH = 120;

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: chartH + 20 }}>
        {buckets.map((b, i) => {
          const rh = Math.max((b.reports / maxR) * chartH, b.reports > 0 ? 10 : 3);
          const oh = Math.max((b.outreach / maxO) * chartH, b.outreach > 0 ? 10 : 3);
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center gap-0.5"
              title={`${b.label}: ${b.reports} reports · ${b.outreach.toLocaleString('en-IN')} outreach`}
            >
              <div className="flex items-end gap-[4px]" style={{ height: chartH }}>
                <div style={{
                  width: 12, height: rh, borderRadius: 999,
                  background: C.dark, transition: 'height .6s',
                }} />
                <div style={{
                  width: 12, height: oh, borderRadius: 999,
                  background: C.lime, transition: 'height .6s',
                }} />
              </div>
              <div style={{ fontSize: 9, color: C.muted, whiteSpace: 'nowrap' }}>{b.label}</div>
            </div>
          );
        })}
      </div>

      {/* Report count + outreach per month */}
      <div className="mt-3 grid grid-cols-6 gap-1 border-t pt-3" style={{ borderColor: '#D9E6E8' }}>
        {buckets.map((b, i) => (
          <div key={i} className="text-center">
            <div className="text-[11px] font-black" style={{ color: C.dark }}>{b.reports}</div>
            <div className="text-[9px]" style={{ color: C.muted }}>
              {b.outreach > 999
                ? `${(b.outreach / 1000).toFixed(1)}k`
                : b.outreach > 0 ? b.outreach.toLocaleString('en-IN') : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
