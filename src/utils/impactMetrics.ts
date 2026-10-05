import type { DailyReport } from '../types/report'

// Jaljeevika's 17-indicator impact framework, classified along Output → Outcome → Impact.
export type ImpactCategory = 'Output' | 'Outcome' | 'Impact'

export interface ImpactIndicator {
  key: string           // matches a key in GET /api/impact/framework → values
  indicator: string
  unit: string
  category: ImpactCategory
}

export const IMPACT_FRAMEWORK: ImpactIndicator[] = [
  { key: 'beneficiary_reach',        indicator: 'Beneficiary reach',                              unit: 'Nos',  category: 'Output'  },
  { key: 'training_engagement',      indicator: 'Training engagement',                            unit: 'Nos',  category: 'Output'  },
  { key: 'campaigns',                indicator: 'No. of campaigns',                               unit: 'Nos',  category: 'Output'  },
  { key: 'production_enhancement',   indicator: 'Production enhancement',                         unit: 'MT',   category: 'Outcome' },
  { key: 'institution_building',     indicator: 'Institution strengthening / building',          unit: 'Nos',  category: 'Outcome' },
  { key: 'women_engagement',         indicator: 'Women engagement',                               unit: 'Nos',  category: 'Outcome' },
  { key: 'partnership_govt',         indicator: 'Partnership with Govt program',                  unit: 'Nos',  category: 'Outcome' },
  { key: 'resources_published',      indicator: 'Resources published',                            unit: 'Nos',  category: 'Outcome' },
  { key: 'partnership_institutions', indicator: 'Partnership with institutions (university, NGO, panchayat etc.)', unit: 'Nos', category: 'Outcome' },
  { key: 'hh_income',                indicator: 'HH income enhanced',                             unit: 'INR',  category: 'Impact'  },
  { key: 'productivity_pct',         indicator: 'Productivity enhanced',                          unit: '%',    category: 'Impact'  },
  { key: 'credit_access',            indicator: 'Access to credit',                               unit: 'INR',  category: 'Impact'  },
  { key: 'scheme_access',            indicator: 'Scheme access',                                  unit: 'Nos',  category: 'Impact'  },
  { key: 'revenue_enhanced',         indicator: 'Revenue enhanced',                               unit: 'INR',  category: 'Impact'  },
  { key: 'employment_generated',     indicator: 'Employment generated',                           unit: 'Nos',  category: 'Impact'  },
  { key: 'wetland_rejuvenation',     indicator: 'Wetland rejuvenation',                           unit: 'Acre', category: 'Impact'  },
  { key: 'adoption_govt',            indicator: 'Adoption of Jaljeevika approach by Govt program', unit: 'Nos', category: 'Impact'  },
]

// null means no MIS data source yet (render "—"), distinct from a real 0.
export type ImpactFrameworkValues = Record<string, number | null>

// INR: Indian grouping with ₹; MT/Acre append the unit; Nos is a plain grouped integer.
export function formatIndicatorValue(value: number | null | undefined, unit: string): string {
  if (value == null) return '—'
  switch (unit) {
    case 'INR':
      return '₹' + Math.round(value).toLocaleString('en-IN')
    case 'MT':
      return `${value.toLocaleString('en-IN', { maximumFractionDigits: 1 })} MT`
    case 'Acre':
      return `${value.toLocaleString('en-IN', { maximumFractionDigits: 1 })} ac`
    case '%':
      return `${value.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`
    default: // Nos
      return value.toLocaleString('en-IN')
  }
}

export const IMPACT_CATEGORY_META: Record<ImpactCategory, { order: number; color: string; sub: string }> = {
  Output:  { order: 0, color: '#16a34a', sub: 'What we deliver' },
  Outcome: { order: 1, color: '#d97706', sub: 'What changes'    },
  Impact:  { order: 2, color: '#341272', sub: 'Lasting effect'  },
}

export const SDG_MAPPINGS = [
  { sdg: 1,  name: 'No Poverty',        color: '#E5243B', areas: ['Livelihoods','SHG','Income'] },
  { sdg: 2,  name: 'Zero Hunger',       color: '#DDA63A', areas: ['Agriculture','Food','Nutrition'] },
  { sdg: 3,  name: 'Good Health',       color: '#4C9F38', areas: ['Health','WASH','Sanitation'] },
  { sdg: 4,  name: 'Quality Education', color: '#C5192D', areas: ['Education','Training','Literacy'] },
  { sdg: 5,  name: 'Gender Equality',   color: '#FF3A21', areas: ['Women','Gender','SHG'] },
  { sdg: 6,  name: 'Clean Water',       color: '#26BDE2', areas: ['Water','WASH','Jal Jeevan'] },
  { sdg: 8,  name: 'Decent Work',       color: '#A21942', areas: ['Livelihoods','Employment','Skill'] },
  { sdg: 13, name: 'Climate Action',    color: '#3F7E44', areas: ['Environment','Climate','Forest'] },
]

export function getSDGCount(reports: DailyReport[], areas: string[]): number {
  return reports.filter(r =>
    areas.some(area =>
      (r.areaOfIntervention ?? '').toLowerCase().includes(area.toLowerCase())
    )
  ).length
}

export function getSDGsWithCounts(reports: DailyReport[]) {
  return SDG_MAPPINGS
    .map(sdg => ({ ...sdg, count: getSDGCount(reports, sdg.areas) }))
    .filter(sdg => sdg.count > 0)
}

export function getToCNodes(reports: DailyReport[]) {
  const totalBenef = reports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
  return [
    {
      label: 'Inputs',
      sublabel: 'field workers',
      value: new Set(reports.map(r => r.name).filter(Boolean)).size,
      color: '#6366f1',
    },
    {
      label: 'Activities',
      sublabel: 'intervention areas',
      value: new Set(reports.map(r => r.areaOfIntervention).filter(Boolean)).size,
      color: '#0891b2',
    },
    {
      label: 'Outputs',
      sublabel: 'reports filed',
      value: reports.length,
      color: '#16a34a',
    },
    {
      label: 'Outcomes',
      sublabel: 'communities reached',
      value: new Set(reports.map(r => r.location).filter(Boolean)).size,
      color: '#d97706',
    },
    {
      label: 'Impact',
      sublabel: 'beneficiaries',
      value: totalBenef,
      color: '#341272',
    },
  ]
}

export function getLogicModelData(reports: DailyReport[]) {
  const totalBenef = reports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
  const photos = reports.filter(r => r.attachmentUrl).length

  const areaFreq: Record<string, number> = {}
  reports.forEach(r => {
    if (r.areaOfIntervention) areaFreq[r.areaOfIntervention] = (areaFreq[r.areaOfIntervention] || 0) + 1
  })
  const topAreas = Object.entries(areaFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([area]) => area)

  const projBenef: Record<string, number> = {}
  reports.forEach(r => {
    if (r.project) projBenef[r.project] = (projBenef[r.project] || 0) + (parseInt(String(r.beneficiaries ?? 0)) || 0)
  })
  const topProject = Object.entries(projBenef).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'

  return {
    inputs: {
      contributors: new Set(reports.map(r => r.name).filter(Boolean)).size,
      projects: new Set(reports.map(r => r.project).filter(Boolean)).size,
    },
    activities: { topAreas },
    outputs: { reportCount: reports.length, photoCount: photos },
    outcomes: {
      states: new Set(reports.map(r => r.state).filter(Boolean)).size,
      locations: new Set(reports.map(r => r.location).filter(Boolean)).size,
    },
    impact: { totalBenef, topProject },
  }
}

export function getDataQualityMetrics(reports: DailyReport[]) {
  if (!reports.length) return { photoCoverage: 0, descCompleteness: 0, contributorConsistency: 0, beneficiaryCompleteness: 0, locationSpecificity: 0 }

  const withPhoto      = reports.filter(r => r.attachmentUrl).length
  const withDesc       = reports.filter(r => (r.description ?? '').length >= 30).length
  const benefComplete  = reports.filter(r => parseInt(String(r.beneficiaries ?? 0)) > 0).length
  const locSpecific    = reports.filter(r => (r.location ?? '').trim().split(' ').length > 1).length

  // Contributor consistency: % who reported in both halves of the period
  const sorted = [...reports].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const mid    = Math.floor(sorted.length / 2)
  const firstHalf  = new Set(sorted.slice(0, mid).map(r => r.name))
  const secondHalf = new Set(sorted.slice(mid).map(r => r.name))
  const consistent = [...firstHalf].filter(n => secondHalf.has(n)).length
  const consistency = firstHalf.size > 0 ? consistent / firstHalf.size : 0

  return {
    photoCoverage:           withPhoto / reports.length,
    descCompleteness:        withDesc  / reports.length,
    contributorConsistency:  consistency,
    beneficiaryCompleteness: benefComplete / reports.length,
    locationSpecificity:     locSpecific   / reports.length,
  }
}

export function getReportingPeriod(reports: DailyReport[]): string {
  if (!reports.length) return '—'
  const timestamps = reports.map(r => r.timestamp).filter(Boolean).sort()
  const fmt = (ts: string) =>
    new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${fmt(timestamps[0])} → ${fmt(timestamps[timestamps.length - 1])}`
}
