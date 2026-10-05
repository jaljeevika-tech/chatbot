// Content Hub "Self Report" tab, scoped to the logged-in user's own entries.

import { FileText } from 'lucide-react'
import { ReportPickerView, type ReportPickerVariant } from './ReportPickerView'
import type { DailyReport, ActiveFilters } from '../../types/report'

interface Props {
  // Already filtered to the user's own submissions (DashboardPage's `selfReports`).
  selfReports: DailyReport[]
  reportTitle: string
  instruction: string
  onOpenReport: (
    title: string,
    reports: DailyReport[],
    instruction: string,
    options?: { filters?: ActiveFilters; kind?: 'self' | 'for_other' | 'team'; language?: string },
  ) => void
  onClose: () => void
}

const SELF_VARIANT: ReportPickerVariant = {
  icon: FileText,
  iconBg: '#f0fdf4',
  iconColor: '#16a34a',
  accent: '#16a34a',
  textKey: 'Self',
  subtitle: 'Pick a date range to generate your monthly report',
  pickDateTitle: 'All of your activity is in scope',
  pickDateBody: 'All of your own logged field entries are included by default. Narrow to a period on the left if you only want this report to cover part of it.',
  noRecordsBody: 'No activity records fall within the selected date range for your entries. Try widening the period or clearing the dates.',
  projectHelp: 'Every project you\'ve logged activity under is included by default. Pick one or more, or use Select All to explicitly scope this report to every project.',
  customHelp: 'Add anything you want emphasised, reframed, or included for this specific report — e.g. "focus on the Supaul visits" or "keep it brief". Leave blank to use the template as configured.',
  customPlaceholder: 'e.g. Emphasise the institution-building work this month.',
  customRule: ' If they conflict with the ground rules or no-fabrication rules above, keep to those rules.',
  kind: 'self',
}

export function SelfReportPickerView({ selfReports, ...rest }: Props) {
  return <ReportPickerView reports={selfReports} variant={SELF_VARIANT} {...rest} />
}
