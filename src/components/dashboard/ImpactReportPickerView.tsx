// Content Hub "Impact Report" tab, scoped to whatever the viewer may see (baseReports).

import { Heart } from 'lucide-react'
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

const IMPACT_VARIANT: ReportPickerVariant = {
  icon: Heart,
  iconBg: '#fef2f2',
  iconColor: '#dc2626',
  accent: FF.purple,
  textKey: 'Impact',
  subtitle: 'Pick a date range to generate this report',
  pickDateTitle: 'All in-scope data is included',
  pickDateBody: 'Every project is included by default. Narrow to a period on the left if you only want this report to cover part of it.',
  noRecordsBody: 'No activity records fall within the selected date range. Try widening the period or clearing the dates.',
  projectHelp: 'Every project is included by default. Pick one or more, or use Select All to explicitly scope this report to every project.',
  customHelp: 'Add anything you want emphasised, reframed, or included for this specific report. Leave blank to use the template as configured.',
  customPlaceholder: 'e.g. Emphasise the beneficiary voices captured this quarter.',
  customRule: '',
}

export function ImpactReportPickerView({ baseReports, ...rest }: Props) {
  return <ReportPickerView reports={baseReports} variant={IMPACT_VARIANT} {...rest} />
}
