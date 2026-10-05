// Shared audit-log writer + middleware for new routes (older routes keep their own
// writeAudit copies with the same shape). The audit trail is what makes DPDP DSRs
// answerable and backs §8(5) "reasonable security safeguards".

import { getPool } from '../db/pool.js'

/** Fire-and-forget audit write; errors are swallowed so auditing never fails a request. */
export async function writeAudit({ orgId, actorUid, actorName, action, targetType, targetId, diff, requestId }) {
  try {
    const pool = getPool()
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, actorUid, actorName || '', action, targetType || null, targetId || null, diff ? JSON.stringify(diff) : null, requestId || null]
    )
  } catch (e) {
    console.warn('[audit] write failed:', e.message)
  }
}

/**
 * Middleware that audits only after a 2xx response (it wraps res.json; mount before the handler).
 * opts.getTargetId(req, body)  — record id; defaults to req.params.id
 * opts.getDiff(req, body)      — diff column; defaults to req.body for POST/PUT, null for DELETE
 * opts.getRequestId(req)       — DSR id (dsr_requests.id) to correlate with; defaults to none
 */
export function auditRoute(action, targetType, opts = {}) {
  const {
    getTargetId = (req) => req.params.id || null,
    getDiff     = (req) => (req.method === 'DELETE' ? null : (req.body || null)),
    getRequestId = () => null,
  } = opts

  return function auditMiddleware(req, res, next) {
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        writeAudit({
          orgId:      req.user.orgId,
          actorUid:   req.user.uid,
          actorName:  req.user.name,
          action,
          targetType,
          targetId:   getTargetId(req, body),
          diff:       getDiff(req, body),
          requestId:  getRequestId(req),
        })
      }
      return originalJson(body)
    }
    next()
  }
}
