// node --test — calendar maths behind leave-day counts and work dates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays, countLeaveDays, dateInTz, isValidDate, isWeeklyOff, leaveOverlaps, leaveYearOf, validateWeeklyOffs,
} from './dates.js'

const SUNDAYS = { 0: [1, 2, 3, 4, 5] }
const SUN_AND_2ND_4TH_SAT = { 0: [1, 2, 3, 4, 5], 6: [2, 4] }

test('isValidDate rejects impossible dates', () => {
  assert.equal(isValidDate('2026-02-28'), true)
  assert.equal(isValidDate('2026-02-30'), false)
  assert.equal(isValidDate('2026-2-3'), false)
  assert.equal(isValidDate(undefined), false)
})

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-03-31', 1), '2026-04-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('leave year runs April to March', () => {
  assert.equal(leaveYearOf('2026-04-01'), 2026)
  assert.equal(leaveYearOf('2027-03-31'), 2026)
  assert.equal(leaveYearOf('2026-03-31'), 2025)
})

test('work date is taken in the org timezone, not UTC', () => {
  // 20:00 UTC on 2 Oct is 01:30 on 3 Oct in India.
  assert.equal(dateInTz(new Date('2026-10-02T20:00:00Z'), 'Asia/Kolkata'), '2026-10-03')
  assert.equal(dateInTz(new Date('2026-10-02T18:00:00Z'), 'Asia/Kolkata'), '2026-10-02')
})

test('weekly offs: every Sunday, 2nd and 4th Saturday', () => {
  // October 2026: Saturdays are 3, 10, 17, 24, 31; Sundays 4, 11, 18, 25.
  assert.equal(isWeeklyOff('2026-10-04', SUN_AND_2ND_4TH_SAT), true)
  assert.equal(isWeeklyOff('2026-10-03', SUN_AND_2ND_4TH_SAT), false) // 1st Saturday
  assert.equal(isWeeklyOff('2026-10-10', SUN_AND_2ND_4TH_SAT), true)  // 2nd
  assert.equal(isWeeklyOff('2026-10-17', SUN_AND_2ND_4TH_SAT), false) // 3rd
  assert.equal(isWeeklyOff('2026-10-24', SUN_AND_2ND_4TH_SAT), true)  // 4th
  assert.equal(isWeeklyOff('2026-10-31', SUN_AND_2ND_4TH_SAT), false) // 5th
  assert.equal(isWeeklyOff('2026-10-05', SUN_AND_2ND_4TH_SAT), false) // Monday
})

test('leave days skip weekly offs and holidays', () => {
  // Fri 9 Oct → Tue 13 Oct 2026: Sat 10 (2nd Sat) and Sun 11 are off.
  assert.equal(countLeaveDays('2026-10-09', '2026-10-13', 'full', SUN_AND_2ND_4TH_SAT, new Set()), 3)
  // Same range with Mon 12 as a holiday.
  assert.equal(countLeaveDays('2026-10-09', '2026-10-13', 'full', SUN_AND_2ND_4TH_SAT, new Set(['2026-10-12'])), 2)
  // Only Sunday off: Sat 10 counts.
  assert.equal(countLeaveDays('2026-10-09', '2026-10-13', 'full', SUNDAYS, new Set()), 4)
})

test('half day counts 0.5, or 0 on a day off', () => {
  assert.equal(countLeaveDays('2026-10-05', '2026-10-05', 'first_half', SUNDAYS, new Set()), 0.5)
  assert.equal(countLeaveDays('2026-10-04', '2026-10-04', 'second_half', SUNDAYS, new Set()), 0)
})

test('opposite halves of the same day do not overlap', () => {
  const am = { start_date: '2026-10-05', end_date: '2026-10-05', day_portion: 'first_half' }
  const pm = { start_date: '2026-10-05', end_date: '2026-10-05', day_portion: 'second_half' }
  const full = { start_date: '2026-10-05', end_date: '2026-10-07', day_portion: 'full' }
  assert.equal(leaveOverlaps(am, pm), false)
  assert.equal(leaveOverlaps(am, am), true)
  assert.equal(leaveOverlaps(am, full), true)
  assert.equal(leaveOverlaps(full, { start_date: '2026-10-08', end_date: '2026-10-08', day_portion: 'full' }), false)
})

test('weekly-off setting validation', () => {
  assert.equal(validateWeeklyOffs(SUN_AND_2ND_4TH_SAT), true)
  assert.equal(validateWeeklyOffs({}), true)
  assert.equal(validateWeeklyOffs({ 7: [1] }), false)
  assert.equal(validateWeeklyOffs({ 0: [6] }), false)
  assert.equal(validateWeeklyOffs([]), false)
})
