// lib/platformAudit.js — audit trail for super admin (cross-tenant) actions.
// Writes to platform_audit_log (migration 082). Fire-and-forget like
// lib/auditMiddleware.js: a failed audit write is logged, never surfaced.

import { getPool } from '../db/pool.js'
import { redactDeep } from './secretMeta.js'

export async function writePlatformAudit(req, { action, targetOrgId = null, targetType = null, targetId = null, diff = null }) {
  try {
    await getPool().query(
      `INSERT INTO platform_audit_log
         (actor_uid, actor_name, actor_org_id, action, target_org_id, target_type, target_id, diff, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        req.user?.uid || 'unknown', req.user?.name || '', req.user?.orgId || null,
        action, targetOrgId, targetType, targetId != null ? String(targetId) : null,
        diff ? JSON.stringify(redactDeep(diff)) : null,
        req.ip || null, String(req.headers['user-agent'] || '').slice(0, 300),
      ]
    )
  } catch (e) {
    console.warn('[platform-audit] write failed:', e.message)
  }
}

/**
 * Middleware: audit after a successful (2xx) JSON response.
 * opts.orgId(req, body) / opts.targetId(req, body) / opts.diff(req, body)
 */
export function auditPlatform(action, targetType, opts = {}) {
  const {
    orgId    = (req) => req.params.id || null,
    targetId = (req, body) => req.params.uid || req.params.id || body?.id || null,
    diff     = (req) => (req.method === 'DELETE' ? null : (req.body || null)),
  } = opts
  return function auditPlatformMiddleware(req, res, next) {
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        writePlatformAudit(req, {
          action, targetType,
          targetOrgId: orgId(req, body),
          targetId:    targetId(req, body),
          diff:        diff(req, body),
        })
      }
      return originalJson(body)
    }
    next()
  }
}
