// Shared role-check guards.

// Any signed-in org member, for read endpoints: every role can view (the UI has a
// read-only mode) and each query's org_id filter already isolates tenants.
export function requireAuth(req, res) {
  if (!req.user?.orgId) {
    res.status(401).json({ error: 'Authentication required' })
    return false
  }
  return true
}

export function requireEditor(req, res) {
  const role = req.user?.role
  if (!['admin', 'superadmin', 'manager'].includes(role)) {
    res.status(403).json({ error: 'Access denied — admin or manager only' })
    return false
  }
  return true
}

export function requireAdmin(req, res) {
  const role = req.user?.role
  if (!['admin', 'superadmin'].includes(role)) {
    res.status(403).json({ error: 'Access denied — admin only' })
    return false
  }
  return true
}
