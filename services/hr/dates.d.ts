// Types for dates.js — the HR tab (src/components/hr) imports the same
// calendar maths the service uses, so leave-day previews match the server.

export type WeeklyOffs = Record<string, number[]>
export interface LeaveSpan { start_date: string; end_date: string; day_portion: string }

export const DATE_RE: RegExp
export function isValidDate(s: unknown): s is string
export function dateInTz(instant: Date, tz: string): string
export function addDays(dateStr: string, n: number): string
export function eachDate(start: string, end: string): string[]
export function leaveYearOf(dateStr: string): number
export function leaveYearRange(startYear: number): { from: string; to: string }
export function isWeeklyOff(dateStr: string, weeklyOffs: WeeklyOffs): boolean
export function countLeaveDays(
  start: string, end: string, dayPortion: string, weeklyOffs: WeeklyOffs, holidaySet: Set<string>,
): number
export function leaveOverlaps(a: LeaveSpan, b: LeaveSpan): boolean
export function validateWeeklyOffs(value: unknown): boolean
