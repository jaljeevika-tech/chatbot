// Output languages for AI-generated reports/content (not the UI language). Plain English
// names, since that's what the report-generation API expects.
export const REPORT_LANGUAGES = [
  'English', 'Hindi', 'Marathi', 'Odia', 'Bengali', 'Telugu',
  'Tamil', 'Gujarati', 'Kannada', 'Malayalam', 'Punjabi', 'Assamese',
] as const

export type ReportLanguage = typeof REPORT_LANGUAGES[number]
