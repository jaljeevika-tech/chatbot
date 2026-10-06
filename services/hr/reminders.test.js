// node --test services/hr/reminders.test.js — auto check-out cut-off.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoCheckOutAt } from './reminders.js'

const tz = 'Asia/Kolkata'
const at = (s) => new Date(s)

test('closes an open day at 10 pm local, not before', () => {
  const checkIn = at('2026-10-06T09:30:00+05:30')
  assert.equal(autoCheckOutAt('2026-10-06', checkIn, '22:00', tz, at('2026-10-06T21:59:00+05:30')), null)
  assert.equal(autoCheckOutAt('2026-10-06', checkIn, '22:00', tz, at('2026-10-06T22:05:00+05:30')).toISOString(), '2026-10-06T16:30:00.000Z')
  // server was down overnight → still closed at that day's 10 pm
  assert.equal(autoCheckOutAt('2026-10-06', checkIn, '22:00', tz, at('2026-10-07T08:00:00+05:30')).toISOString(), '2026-10-06T16:30:00.000Z')
})

test('a check-in after the cut-off is left alone', () => {
  assert.equal(autoCheckOutAt('2026-10-06', at('2026-10-06T22:30:00+05:30'), '22:00', tz, at('2026-10-06T23:00:00+05:30')), null)
})
