// Content Hub "Org Report" tab. The subject is always the whole org.

import { Building2 } from 'lucide-react'
import { FF } from '../../theme/colors'
import { ReportPickerView, type ReportPickerVariant } from './ReportPickerView'
import type { DailyReport, ActiveFilters } from '../../types/report'

interface Props {
  baseReports: DailyReport[]
  reportTitle: string
  instruction: string
  onOpenReport: (
    title: string,
    reports: DailyReport[],
    instruction: string,
    options?: { filters?: ActiveFilters; language?: string },
  ) => void
  onClose: () => void
}

const ORG_VARIANT: ReportPickerVariant = {
  icon: Building2,
  iconBg: '#f5f3ff',
  iconColor: '#7c3aed',
  accent: FF.purple,
  textKey: 'Org',
  subtitle: 'Pick a date range to generate this report',
  pickDateTitle: 'All org data is in scope',
  pickDateBody: 'Every project is included by default. Narrow to a period on the left if you only want this report to cover part of it.',
  noRecordsBody: 'No activity records fall within the selected date range. Try widening the period or clearing the dates.',
  projectHelp: 'Every project is included by default. Pick one or more, or use Select All to explicitly scope this report to every project.',
  customHelp: 'Add anything you want emphasised, reframed, or included for this specific report — e.g. "lead with the Kosi Sahajivan numbers" or "keep the tone donor-facing". Leave blank to use the template as configured.',
  customPlaceholder: 'e.g. Emphasise convergence and government partnerships this quarter.',
  customRule: ' If they conflict with the aggregation-integrity or no-fabrication rules above, keep to those rules.',
}

export function OrgReportPickerView({ baseReports, ...rest }: Props) {
  return <ReportPickerView reports={baseReports} variant={ORG_VARIANT} {...rest} />
}
