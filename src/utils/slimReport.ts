// Trims DailyReports to the fields the AI report route reads (buildReportPrompt in
// routes/reports.routes.js) and applies its MAX_REPORTS cap, keeping POSTs under the 5 MB limit.

import type { DailyReport } from '../types/report'

// Mirror the server's slice in `routes/reports.routes.js`
export const SLIM_DESC_LIMIT  = 500   // server further slices to 180; we send a generous buffer for context
export const SLIM_MAX_REPORTS = 2000  // matches `MAX_REPORTS` in the route

/** One report stripped to the fields the AI route reads; everything else is dropped. */
export interface SlimReport {
  id?: string
  timestamp: string
  name: string
  state: string
  location: string
  project: string
  areaOfIntervention: string
  description: string
  beneficiaries: number | string | null
  attachmentUrl: string | null
}

export function slimReportForApi(r: DailyReport): SlimReport {
  return {
    id:                 r.id,
    timestamp:          r.timestamp,
    name:               r.name,
    state:              r.state,
    location:           r.location,
    project:            r.project,
    areaOfIntervention: r.areaOfIntervention,
    description:        typeof r.description === 'string' ? r.description.slice(0, SLIM_DESC_LIMIT) : '',
    beneficiaries:      r.beneficiaries,
    attachmentUrl:      r.attachmentUrl,
  }
}

/** Slim + cap for AI route POSTs: oldest first, as the server expects, keeping the
 *  most recent N when over the cap. */
export function slimReportsForApi(reports: DailyReport[]): SlimReport[] {
  if (!Array.isArray(reports) || reports.length === 0) return []
  let trimmed = reports
  if (reports.length > SLIM_MAX_REPORTS) {
    trimmed = [...reports]
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, SLIM_MAX_REPORTS)
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
  }
  return trimmed.map(slimReportForApi)
}
