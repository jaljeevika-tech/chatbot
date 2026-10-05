// Which Daily Reports belong to a project, shared by AnnualProgressReportPage and
// ProjectDashboardPage. Merges the Google Sheet rows (ReportContext, where most history
// lives) with Quick Report rows from GET /api/reports/for-project.
import { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../utils/apiFetch'
import { useReportContext } from '../context/ReportContext'
import type { DailyReport } from '../types/report'

// Renamed projects whose project_key (trailing "-<year>" stripped) shares nothing with the
// short name field workers pick in the report form.
const PROJECT_KEY_ALIASES: Record<string, string> = {
  'jal-samriddhi-strengthening-fisheries-based-livelihoods-in-gadchiroli-maharashtra': 'jal-smaridhi-apf',
}

export function useProjectDailyReports(projectName: string, projectKey?: string, locationFilter = '', limit = 200) {
  const { reports: sheetReports } = useReportContext()
  const [pgReports, setPgReports] = useState<DailyReport[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectName) return
    let cancelled = false
    setLoading(true)
    const url = `/api/reports/for-project?project=${encodeURIComponent(projectName)}` +
      (locationFilter ? `&location=${encodeURIComponent(locationFilter)}` : '') + `&limit=${limit}`
    apiFetch(url)
      .then(r => r.json())
      .then(d => { if (!cancelled) setPgReports(d.reports || []) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectName, locationFilter, limit])

  const reports = useMemo(() => {
    const nameLower = projectName.trim().toLowerCase()
    const keyBase = (projectKey || '').replace(/-\d{4}$/, '')
    const keyNorm = (PROJECT_KEY_ALIASES[keyBase] || keyBase).replace(/[^a-z0-9]/gi, '').toLowerCase()
    const matches = (r: DailyReport) => {
      const projectRaw = r.project?.trim().toLowerCase() || ''
      const nameMatches = projectRaw.includes(nameLower)
      const keyMatches = keyNorm.length > 0 && projectRaw.replace(/[^a-z0-9]/g, '').startsWith(keyNorm)
      if (!nameMatches && !keyMatches) return false
      if (locationFilter && !r.location?.trim().toLowerCase().includes(locationFilter.trim().toLowerCase())) return false
      return true
    }
    const fromSheet = sheetReports.filter(matches)
    const seen = new Set(fromSheet.map(r => r.id))
    const merged = [...fromSheet, ...pgReports.filter(r => !seen.has(r.id) && matches(r))]
    return merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  }, [sheetReports, pgReports, projectName, projectKey, locationFilter])

  return { reports, loading }
}
