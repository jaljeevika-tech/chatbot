// node --test — shift windows and late / early / worked minutes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  earlyLeaveMinutes, lateMinutes, shiftLengthMinutes, shiftWindow, workedMinutes, zonedDateTime,
} from './shifts.js'

const IST = 'Asia/Kolkata'
const GENERAL = { start_time: '09:30', end_time: '18:00', grace_minutes: 15, min_full_day_minutes: 360 }
const NIGHT = { start_time: '22:00:00', end_time: '06:00:00', grace_minutes: 10, min_full_day_minutes: 360 }

test('wall-clock time in IST maps to the right instant', () => {
  assert.equal(zonedDateTime('2026-10-05', '09:30', IST).toISOString(), '2026-10-05T04:00:00.000Z')
  assert.equal(zonedDateTime('2026-10-05', '00:15', IST).toISOString(), '2026-10-04T18:45:00.000Z')
})

test('DST zone resolves correctly', () => {
  // New York is UTC-4 in October.
  assert.equal(zonedDateTime('2026-10-05', '09:00', 'America/New_York').toISOString(), '2026-10-05T13:00:00.000Z')
})

test('night shift ends the next day', () => {
  const w = shiftWindow(NIGHT, '2026-10-05', IST)
  assert.equal(w.start.toISOString(), '2026-10-05T16:30:00.000Z')
  assert.equal(w.end.toISOString(), '2026-10-06T00:30:00.000Z')
  assert.equal(shiftLengthMinutes(NIGHT), 480)
  assert.equal(shiftLengthMinutes(GENERAL), 510)
})

test('late only counts beyond grace, measured from shift start', () => {
  const at = (hhmm) => zonedDateTime('2026-10-05', hhmm, IST)
  assert.equal(lateMinutes(at('09:20'), GENERAL, '2026-10-05', IST), 0)
  assert.equal(lateMinutes(at('09:44'), GENERAL, '2026-10-05', IST), 0)    // 14 min, inside grace
  assert.equal(lateMinutes(at('09:52'), GENERAL, '2026-10-05', IST), 22)   // past grace → full 22
})

test('early leave only counts beyond grace', () => {
  const at = (hhmm) => zonedDateTime('2026-10-05', hhmm, IST)
  assert.equal(earlyLeaveMinutes(at('17:50'), GENERAL, '2026-10-05', IST), 0)
  assert.equal(earlyLeaveMinutes(at('17:00'), GENERAL, '2026-10-05', IST), 60)
  assert.equal(earlyLeaveMinutes(at('18:30'), GENERAL, '2026-10-05', IST), 0)
})

test('worked minutes', () => {
  assert.equal(workedMinutes(new Date('2026-10-05T04:00:00Z'), new Date('2026-10-05T12:23:00Z')), 503)
  assert.equal(workedMinutes(new Date('2026-10-05T04:00:00Z'), new Date('2026-10-05T03:00:00Z')), 0)
})
