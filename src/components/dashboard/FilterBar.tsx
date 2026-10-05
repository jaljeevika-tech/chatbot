import { useState } from 'react';
import { SlidersHorizontal, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useAuthContext } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import type { ActiveFilters, DailyReport } from '../../types/report';
import { MultiSelect } from './MultiSelect';

interface Props {
  reports: DailyReport[];
  filters: ActiveFilters;
  onChange: (f: ActiveFilters) => void;
}

export function FilterBar({ reports, filters, onChange }: Props) {
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  // Options come from the loaded data, so every value that appears in reports is selectable.
  const projects = [...new Set(reports.map(r => r.project).filter(Boolean))].sort()
  const states   = [...new Set(reports.map(r => r.state).filter(Boolean))].sort()
  const areas    = [...new Set(reports.map(r => r.areaOfIntervention).filter(Boolean))].sort()
  const workers  = [...new Set(reports.map(r => r.name).filter(n => n && n.length < 60))].sort()

  // Opens the panel when the first filter is applied
  function update(key: keyof ActiveFilters, val: any) {
    onChange({ ...filters, [key]: val })
    setOpen(true)
  }

  const activeCount =
    filters.project.length +
    filters.state.length +
    filters.area.length +
    filters.workerName.length +
    (filters.dateFrom ? 1 : 0) +
    (filters.dateTo   ? 1 : 0)

  const hasActiveFilters = activeCount > 0

  function clearAll() {
    onChange({ project: [], state: [], area: [], workerName: [], dateFrom: '', dateTo: '' })
    setOpen(false)
  }

  const activeSummary: string[] = [
    ...filters.project,
    ...filters.state,
    ...filters.workerName.map(w => w.split(' ')[0]),
    ...filters.area.map(a => a.slice(0, 10)),
    ...(filters.dateFrom ? [filters.dateFrom] : []),
    ...(filters.dateTo   ? [`→ ${filters.dateTo}`] : []),
  ]

  return (
    <div className="mb-4 bg-white rounded-2xl border border-gray-100 shadow-sm">

      {/* Pill header: always visible, click to toggle */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 transition-colors rounded-2xl"
      >
        <SlidersHorizontal className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span className="text-xs font-bold text-gray-500 shrink-0">Filters</span>

        {/* overflow-hidden stops chips pushing the chevron off-screen */}
        {hasActiveFilters && (
          <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
            {activeSummary.slice(0, 4).map((label, i) => (
              <span
                key={i}
                className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 max-w-[90px] truncate"
              >
                {label}
              </span>
            ))}
            {activeSummary.length > 4 && (
              <span className="shrink-0 text-[10px] font-semibold text-gray-400">
                +{activeSummary.length - 4}
              </span>
            )}
          </div>
        )}

        {/* Keeps the chevron right-aligned when there are no chips */}
        {!hasActiveFilters && <span className="flex-1" />}

        <div className="flex items-center gap-1.5 shrink-0">
          {hasActiveFilters && (
            <span className="text-[10px] font-black bg-purple-600 text-white rounded-full w-4 h-4 flex items-center justify-center leading-none">
              {activeCount}
            </span>
          )}
          {open
            ? <ChevronUp   className="w-3.5 h-3.5 text-gray-400" />
            : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
          }
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3 overflow-visible">

          {/* overflow-visible so dropdown panels float above the date row */}
          <div className="flex flex-wrap gap-2 overflow-visible">
            {(user?.role === 'admin' || user?.role === 'manager' || user?.role === 'superadmin') && (
              <MultiSelect
                label={t.filterContributor}
                placeholder={t.filterContributor}
                options={workers}
                selected={filters.workerName}
                onChange={val => update('workerName', val)}
              />
            )}
            <MultiSelect
              label={t.filterProject}
              placeholder={t.filterProject}
              options={projects}
              selected={filters.project}
              onChange={val => update('project', val)}
            />
            <MultiSelect
              label={t.filterState}
              placeholder={t.filterState}
              options={states}
              selected={filters.state}
              onChange={val => update('state', val)}
            />
            <MultiSelect
              label={t.filterArea}
              placeholder={t.filterArea}
              options={areas}
              selected={filters.area}
              onChange={val => update('area', val)}
            />
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <div className={`flex items-center gap-2 border rounded-xl px-3 py-1.5 flex-1 min-w-[130px] ${
              filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo
                ? 'border-red-300 bg-red-50'
                : 'border-gray-100 bg-gray-50'
            }`}>
              <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest shrink-0">
                {t.filterFrom}
              </label>
              <input
                type="date"
                className="bg-transparent text-xs text-gray-700 font-bold focus:outline-none w-full"
                value={filters.dateFrom}
                max={filters.dateTo || undefined}
                onChange={e => update('dateFrom', e.target.value)}
              />
            </div>
            <div className={`flex items-center gap-2 border rounded-xl px-3 py-1.5 flex-1 min-w-[130px] ${
              filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo
                ? 'border-red-300 bg-red-50'
                : 'border-gray-100 bg-gray-50'
            }`}>
              <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest shrink-0">
                {t.filterTo}
              </label>
              <input
                type="date"
                className="bg-transparent text-xs text-gray-700 font-bold focus:outline-none w-full"
                value={filters.dateTo}
                min={filters.dateFrom || undefined}
                onChange={e => {
                  if (filters.dateFrom && e.target.value < filters.dateFrom) return
                  update('dateTo', e.target.value)
                }}
              />
            </div>
            {hasActiveFilters && (
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 text-[10px] font-black text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 transition-colors shrink-0 px-3 py-2 rounded-xl uppercase tracking-widest"
              >
                <X className="w-3 h-3" />
                {t.resetFilters}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
