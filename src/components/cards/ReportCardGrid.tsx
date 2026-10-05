import { useState, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import type { DailyReport, ActiveFilters } from '../../types/report';
import { ReportCard } from './ReportCard';

interface Props { reports: DailyReport[]; filters?: ActiveFilters }

const PAGE_SIZE = 24;

function searchMatch(r: DailyReport, q: string): boolean {
  if (!q) return true;
  const haystack = [r.name, r.project, r.state, r.areaOfIntervention, r.description, r.location]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

export function ReportCardGrid({ reports, filters }: Props) {
  const [query, setQuery]   = useState('');
  const [page, setPage]     = useState(1);

  const anyFilterActive = !!(
    filters && (
      filters.dateFrom ||
      filters.dateTo ||
      (filters.workerName && filters.workerName.length > 0) ||
      (filters.project && filters.project.length > 0) ||
      (filters.state && filters.state.length > 0) ||
      (filters.area && filters.area.length > 0) ||
      (filters.location && filters.location.length > 0)
    )
  );

  const sorted = useMemo(
    () => [...reports].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))),
    [reports]
  );

  const filtered = useMemo(
    () => sorted.filter(r => searchMatch(r, query)),
    [sorted, query]
  );

  const visible   = filtered.slice(0, page * PAGE_SIZE);
  const remaining = filtered.length - visible.length;

  function handleSearch(val: string) {
    setQuery(val);
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Search by name, project, area, description…"
          className="w-full pl-9 pr-9 py-2.5 text-sm bg-white border border-gray-200 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition placeholder:text-gray-400"
        />
        {query && (
          <button
            onClick={() => handleSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {query && (
        <p className="text-xs text-gray-400 font-semibold px-1">
          {filtered.length === 0
            ? 'No results'
            : `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`}
        </p>
      )}

      {/* Report count when any filter is active */}
      {!query && anyFilterActive && (
        <p className="text-sm font-bold text-purple-700 bg-purple-50 border border-purple-100 rounded-xl px-3 py-2">
          {filtered.length} report{filtered.length !== 1 ? 's' : ''} submitted
        </p>
      )}

      {filtered.length === 0 && !query && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-5xl mb-3">📋</div>
          <p className="font-medium text-gray-500">No reports match your filters.</p>
          <p className="text-sm mt-1">Try adjusting the filters above.</p>
        </div>
      )}

      {filtered.length === 0 && query && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-5xl mb-3">🔍</div>
          <p className="font-medium text-gray-500">No reports found for "{query}"</p>
          <p className="text-sm mt-1">Try a different keyword or clear the search.</p>
        </div>
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map(r => <ReportCard key={r.id} report={r} />)}
        </div>
      )}

      {remaining > 0 && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => setPage(p => p + 1)}
            className="px-6 py-2.5 text-sm font-bold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-2xl transition border border-blue-100"
          >
            Load more ({remaining} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
