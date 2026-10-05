// Server-side enforcement of the org's plan and subscription.
//   ok        — normal
//   grace     — expired < 7 days ago: everything works, UI shows a banner
//   read_only — suspended or past grace: reads/exports work; writes are refused
//               except field capture (HR attendance, WhatsApp/quick report) and
//               legal-duty routes (DSR, consent, erasure). AI is refused; data is kept.
// 'inactive' (the migration-002 default) is not enforced — only explicit
// 'expired' / 'suspended' or a passed expires_at lock an org. No plan = no limits.

import { getPool } from '../db/pool.js'

export const GRACE_DAYS = 7
const TTL = 60_000
const _cache = new Map()

// Path prefixes (relative to /api) that call a paid AI model.
const AI_PREFIXES = [
  '/get-ai-report', '/story-finder', '/generate-social-post', '/notebook/', '/rw/',
  '/analytics/worker', '/analyze-report-impact', '/analyze-toc-aggregate', '/ai/ask',
  '/ai/seed-memories', '/ai-extract/', '/reports/quick-extract', '/wa/flows/generate',
]

// Writes still allowed while read-only.
const READ_ONLY_WRITE_ALLOW = [
  '/auth/', '/hr/', '/wa/reports/submit', '/reports/quick-submit',
  '/dsr', '/consent', '/beneficiary-erasure/',
]

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// '/rw/' and '/rw' both mean "the /rw route and everything under it".
const startsWithAny = (path, list) => list.some(p => {
  const base = p.replace(/\/$/, '')
  return path === base || path.startsWith(base + '/')
})

export function computeAccess(row, now = Date.now()) {
  if (!row) return { state: 'ok' }
  const status = row.subscription_status || 'inactive'
  const exp = row.subscription_expires_at ? new Date(row.subscription_expires_at).getTime() : null
  const graceEnds = exp ? exp + GRACE_DAYS * 86_400_000 : null
  const base = {
    status,
    plan: row.plan_id ? { id: row.plan_id, name: row.plan_name, max_users: row.max_users, ai_enabled: row.ai_enabled } : null,
    expires_at: exp ? new Date(exp).toISOString() : null,
    grace_ends_at: graceEnds ? new Date(graceEnds).toISOString() : null,
  }
  if (status === 'suspended') return { ...base, state: 'read_only', reason: 'suspended' }
  if (status === 'expired') {
    if (graceEnds && now < graceEnds) return { ...base, state: 'grace', reason: 'expired' }
    return { ...base, state: 'read_only', reason: 'expired' }
  }
  if (exp && now > exp && (status === 'active' || status === 'trialing')) {
    return now < graceEnds
      ? { ...base, state: 'grace', reason: 'expired' }
      : { ...base, state: 'read_only', reason: 'expired' }
  }
  return { ...base, state: 'ok' }
}

export async function getOrgAccess(orgId) {
  if (!orgId) return { state: 'ok' }
  const hit = _cache.get(orgId)
  if (hit && Date.now() - hit.ts < TTL) return hit.access
  const { rows } = await getPool().query(
    `SELECT o.subscription_status, o.subscription_expires_at,
            p.id AS plan_id, p.name AS plan_name, p.max_users, p.ai_enabled
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.id = $1`,
    [orgId]
  )
  const access = computeAccess(rows[0])
  _cache.set(orgId, { access, ts: Date.now() })
  return access
}

export function invalidateOrgAccess(orgId) {
  if (orgId) _cache.delete(orgId)
  else _cache.clear()
}

/** Express middleware — mount after requireAuth on /api. */
export async function subscriptionGuard(req, res, next) {
  if (!req.user || req.user.role === 'superadmin' || !req.user.orgId) return next()
  let access
  try { access = await getOrgAccess(req.user.orgId) }
  catch (e) {
    // Fail open: a DB hiccup in the guard must not take every tenant down.
    console.warn('[subscription-guard] lookup failed:', e.message)
    return next()
  }
  req.orgAccess = access
  const path = req.path

  const isAi = startsWithAny(path, AI_PREFIXES)
  if (isAi && access.plan && access.plan.ai_enabled === false) {
    return res.status(403).json({ error: 'AI features are not included in your plan. Contact your administrator to upgrade.', code: 'PLAN_NO_AI' })
  }
  if (access.state === 'read_only') {
    if (isAi) {
      return res.status(403).json({ error: 'Your organisation is in read-only mode, so AI features are paused.', code: 'ORG_READ_ONLY' })
    }
    if (!SAFE_METHODS.has(req.method) && !startsWithAny(path, READ_ONLY_WRITE_ALLOW)) {
      const why = access.reason === 'suspended' ? 'suspended' : 'subscription has expired'
      return res.status(403).json({ error: `Your organisation's ${why}. Data is read-only — you can still view and export. Contact your administrator.`, code: 'ORG_READ_ONLY' })
    }
  }
  next()
}

/** Seat check before adding a user. Returns { ok, used, max }. */
export async function checkSeatAvailable(orgId) {
  const { rows } = await getPool().query(
    `SELECT p.max_users, (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id) AS used
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`,
    [orgId]
  )
  const r = rows[0]
  if (!r || r.max_users == null) return { ok: true, used: r?.used ?? 0, max: null }
  return { ok: r.used < r.max_users, used: r.used, max: r.max_users }
}
