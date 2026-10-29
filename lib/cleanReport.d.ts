// Types for lib/cleanReport.js (shared with the web app).

import type { DailyReport } from '../src/types/report'

export const CANONICAL_PROJECTS: string[]
export const CANONICAL_STATES: string[]
export const CANONICAL_AREAS: string[]

export function mergeProjectAlias(project: string, state?: string, location?: string): string
export function cleanReport(report: DailyReport): DailyReport
export function cleanReports(reports: DailyReport[]): DailyReport[]
export function sheetRowToReport(row: Record<string, unknown>, index: number): DailyReport
