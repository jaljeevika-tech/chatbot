// Per-org daily AI call tracking: past the daily Pro quota, requests are served by
// Flash instead (~85% cheaper) with a notice in the stream. In-process only; a
// restart resets counts, which is fine since instances restart at least daily.

const _counts = new Map()   // orgId → { date:string, pro:number, flash:number }

const PRO_DAILY_LIMIT   = 40    // ~one Pro call per 36 min during a 24-hour day
const FLASH_DAILY_LIMIT = 500   // extremely generous; Flash is cheap

function _today() { return new Date().toISOString().slice(0, 10) }

function _entry(orgId) {
  const today = _today()
  let e = _counts.get(orgId)
  if (!e || e.date !== today) {
    e = { date: today, pro: 0, flash: 0 }
    _counts.set(orgId, e)
  }
  return e
}

/** Record an AI call; returns { downgraded, proUsed, flashUsed }. */
export function trackAndCheck(orgId, tier = 'flash') {
  if (!orgId) return { downgraded: false, proUsed: 0, flashUsed: 0 }

  const e = _entry(orgId)

  if (tier === 'pro') {
    if (e.pro >= PRO_DAILY_LIMIT) {
      // Downgrade: count as flash instead
      e.flash++
      return { downgraded: true, proUsed: e.pro, flashUsed: e.flash }
    }
    e.pro++
    return { downgraded: false, proUsed: e.pro, flashUsed: e.flash }
  }

  e.flash = Math.min(e.flash + 1, FLASH_DAILY_LIMIT)
  return { downgraded: false, proUsed: e.pro, flashUsed: e.flash }
}
