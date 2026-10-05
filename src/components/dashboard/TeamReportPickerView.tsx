// Content Hub "Team Report" tab, scoped to every team member except the logged-in user.

import { Users } from 'lucide-react'
import { FF } from '../../theme/colors'
import { ReportPickerView, type ReportPickerVariant } from './ReportPickerView'
import type { DailyReport, ActiveFilters } from '../../types/report'

interface Props {
  // Already filtered to everyone but the logged-in user (DashboardPage's `teamReports`).
  teamReports: DailyReport[]
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

const TEAM_VARIANT: ReportPickerVariant = {
  icon: Users,
  iconBg: '#eff6ff',
  iconColor: '#2563eb',
  accent: FF.purple,
  textKey: 'Team',
  subtitle: 'Pick a date range to generate this report',
  pickDateTitle: 'The whole team’s activity is in scope',
  pickDateBody: 'Every team member and project is included by default. Narrow to a period on the left if you only want this report to cover part of it.',
  noRecordsBody: 'No activity records fall within the selected date range. Try widening the period or clearing the dates.',
  projectHelp: 'Every project the team worked across is included by default. Pick one or more, or use Select All to explicitly scope this report to every project.',
  customHelp: 'Add anything you want emphasised, reframed, or included for this specific report. Leave blank to use the template as configured.',
  customPlaceholder: 'e.g. Emphasise cross-team coordination this month.',
  customRule: '',
}

export function TeamReportPickerView({ teamReports, ...rest }: Props) {
  return <ReportPickerView reports={teamReports} variant={TEAM_VARIANT} {...rest} />
}
