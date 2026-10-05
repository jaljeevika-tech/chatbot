// routes/workers.routes.js — Worker/user management (Google Sheet based) + AI analytics
// POST   /api/add-user
// PUT    /api/update-user
// DELETE /api/delete-user
// PATCH  /api/set-user-active
// POST   /api/merge-users    — merge a duplicate user into a primary record
// POST   /api/analytics/worker  (AI SSE)
//
// Google Sheet columns:
//   A: Name  B: Phone  C: State  D: Role  E: Manager  F: Password  G: Active
//   H: Employee_ID  I: Designation  J: Project_IDs (comma-separated)

import { Router } from 'express'
import { getGoogleAccessToken, normPhone, findUserRowIndex, resolveUsersSheetId, USERS_SHEET_NAME } from '../lib/sheets.js'
import { setupSSE, sendSSE, callGeminiNotebook, makeAbortSignal } from '../lib/gemini.js'
import { trackUsage } from '../lib/usageTracker.js'
import { getPool } from '../db/pool.js'
import { checkSeatAvailable } from '../lib/subscriptionGuard.js'
import { admin, ensureFirebase } from '../lib/auth.js'

const router = Router()

// Sheet edits alone don't stop a DB-password login or an already-issued token,
// so deactivation is mirrored to the users row and live sessions are revoked.
async function setDbUserActive(orgId, phone, active) {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE users SET exit_date=${active ? 'NULL' : 'LEAST(COALESCE(exit_date, CURRENT_DATE), CURRENT_DATE)'}
      WHERE org_id=$1 AND phone=$2 RETURNING firebase_uid`, [orgId, phone])
  // users.active isn't in every schema; set it where it exists.
  await pool.query('UPDATE users SET active=$3 WHERE org_id=$1 AND phone=$2', [orgId, phone, active]).catch(() => {})
  if (active) return
  ensureFirebase()
  for (const { firebase_uid } of rows) {
    if (!firebase_uid) continue
    try { await admin.auth().revokeRefreshTokens(firebase_uid) }
    catch (e) { if (e.code !== 'auth/user-not-found') console.warn('[workers] revoke failed:', e.message) }
  }
}

// ── Header bootstrap ──────────────────────────────────────────────────────────
/** Ensure cols A–J have correct headers (idempotent). */
async function ensureHeaders(token, sheetId) {
  try {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!A1:J1`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const d = await r.json()
    const row = d.values?.[0] ?? []
    // Fill any blank header cells
    const headers = ['Name', 'Phone', 'State', 'Role', 'Manager', 'Password', 'Active', 'Employee_ID', 'Designation', 'Project_IDs']
    const needsWrite = headers.some((h, i) => !row[i])
    if (needsWrite) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!A1:J1?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [headers] }),
        }
      )
    }
  } catch { /* non-critical */ }
}

// An org admin can never grant 'superadmin' (platform-wide, cross-tenant);
// only an existing superadmin can.
function _canAssignRole(callerRole, targetRole) {
  if (String(targetRole || '').trim().toLowerCase() === 'superadmin') {
    return callerRole === 'superadmin'
  }
  return true
}

/** Fire-and-forget audit log write */
async function writeAudit(orgUuid, actorUid, actorName, action, targetType, targetId, diff) {
  try {
    const pool = getPool()
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgUuid, actorUid, actorName || '', action, targetType || null, targetId || null, diff ? JSON.stringify(diff) : null]
    )
  } catch { /* non-critical */ }
}

// ── POST /api/add-user ────────────────────────────────────────────────────────
router.post('/add-user', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'Admin role required to manage users.' })

  const { name, phone, state, role, manager, password,
          employee_id, designation, project_ids } = req.body || {}
  if (!name?.trim() || !phone?.trim() || !role?.trim())
    return res.status(400).json({ error: 'Name, phone and role are required.' })
  if (!_canAssignRole(req.user.role, role))
    return res.status(403).json({ error: 'Only a superadmin can assign the superadmin role.' })

  // Plan seat limit (re-adding an existing phone doesn't take a new seat).
  if (req.user.role !== 'superadmin') {
    const pool = getPool()
    const { rows: existing } = await pool.query('SELECT 1 FROM users WHERE org_id = $1 AND phone = $2', [req.user.orgId, normPhone(phone)])
    const seat = existing.length ? { ok: true } : await checkSeatAvailable(req.user.orgId)
    if (!seat.ok)
      return res.status(409).json({ error: `Your plan allows ${seat.max} users and all seats are in use. Contact your administrator to upgrade.`, code: 'SEAT_LIMIT' })
  }

  const sheetId = await resolveUsersSheetId(req.user)
  // An org without its own sheet must never fall through to another tenant's
  // sheet (see lib/sheets.js resolveUsersSheetId).
  if (!sheetId)
    return res.status(400).json({ error: 'User management is not set up for this organization yet. Ask your superadmin to configure a users sheet in Org Settings.' })
  const token   = await getGoogleAccessToken()
  if (!token)
    return res.status(503).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not configured on the server.' })

  await ensureHeaders(token, sheetId)

  const projectStr = Array.isArray(project_ids) ? project_ids.join(',') : (project_ids || '')
  const row = [
    name.trim(),
    normPhone(phone),
    (state       || '').trim(),
    role.trim(),
    (manager     || '').trim(),
    (password    || '').trim(),
    'TRUE',
    (employee_id || '').trim(),
    (designation || '').trim(),
    projectStr.trim(),
  ]
  const appendRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!A:J:append?valueInputOption=USER_ENTERED`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) }
  )
  if (!appendRes.ok) {
    console.error('[add-user] sheet write failed:', await appendRes.text())
    return res.status(500).json({ error: 'Failed to update the users sheet.' })
  }

  // Mirror to PostgreSQL users table (best-effort)
  try {
    const pool = getPool()
    await pool.query(
      `INSERT INTO users (org_id, phone, name, role, designation, project_ids)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, phone) DO UPDATE SET
         name        = EXCLUDED.name,
         role        = EXCLUDED.role,
         designation = EXCLUDED.designation,
         project_ids = EXCLUDED.project_ids`,
      [req.user.orgId, normPhone(phone), name.trim(), role.trim(),
       (designation || '').trim(), Array.isArray(project_ids) ? project_ids : []]
    )
  } catch { /* non-critical — sheet is source of truth */ }

  writeAudit(req.user.orgId, req.user.uid, req.user.name, 'user.create', 'user', normPhone(phone), { name: name.trim(), role, designation, project_ids })

  res.json({ success: true })
})

// ── PUT /api/update-user ──────────────────────────────────────────────────────
router.put('/update-user', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'Admin role required to manage users.' })

  const { originalPhone, name, phone, state, role, manager, password, active,
          employee_id, designation, project_ids } = req.body || {}
  if (!originalPhone?.trim() || !name?.trim() || !phone?.trim() || !role?.trim())
    return res.status(400).json({ error: 'originalPhone, name, phone and role are required.' })
  if (!_canAssignRole(req.user.role, role))
    return res.status(403).json({ error: 'Only a superadmin can assign the superadmin role.' })

  const sheetId = await resolveUsersSheetId(req.user)
  if (!sheetId)
    return res.status(400).json({ error: 'User management is not set up for this organization yet. Ask your superadmin to configure a users sheet in Org Settings.' })
  const token   = await getGoogleAccessToken()
  if (!token)
    return res.status(503).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not configured on the server.' })

  await ensureHeaders(token, sheetId)
  const rowIdx = await findUserRowIndex(token, originalPhone, sheetId)
  if (rowIdx < 0) return res.status(404).json({ error: 'User not found in sheet.' })

  const activeVal  = active === false || active === 'FALSE' ? 'FALSE' : 'TRUE'
  const projectStr = Array.isArray(project_ids) ? project_ids.join(',') : (project_ids || '')
  const row = [
    name.trim(),
    normPhone(phone),
    (state       || '').trim(),
    role.trim(),
    (manager     || '').trim(),
    (password    || '').trim(),
    activeVal,
    (employee_id || '').trim(),
    (designation || '').trim(),
    projectStr.trim(),
  ]
  const updateRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!A${rowIdx}:J${rowIdx}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) }
  )
  if (!updateRes.ok) {
    console.error('[update-user] sheet write failed:', await updateRes.text())
    return res.status(500).json({ error: 'Failed to update the users sheet.' })
  }

  // Mirror to PostgreSQL
  try {
    const pool = getPool()
    await pool.query(
      `UPDATE users SET name=$1, role=$2, designation=$3, project_ids=$4, phone=$7
       WHERE org_id=$5 AND phone=$6`,
      [name.trim(), role.trim(), (designation || '').trim(),
       Array.isArray(project_ids) ? project_ids : [],
       req.user.orgId, normPhone(originalPhone), normPhone(phone)]
    )
  } catch (e) { console.warn('[update-user] DB mirror failed:', e.message) }
  await setDbUserActive(req.user.orgId, normPhone(phone), activeVal === 'TRUE')

  writeAudit(req.user.orgId, req.user.uid, req.user.name, 'user.update', 'user', normPhone(originalPhone), { name, role, active: activeVal, designation, project_ids })

  res.json({ success: true })
})

// ── DELETE /api/delete-user ───────────────────────────────────────────────────
router.delete('/delete-user', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'Admin role required to manage users.' })

  const { phone } = req.body || {}
  if (!phone?.trim()) return res.status(400).json({ error: 'phone is required.' })

  const sheetId = await resolveUsersSheetId(req.user)
  if (!sheetId)
    return res.status(400).json({ error: 'User management is not set up for this organization yet. Ask your superadmin to configure a users sheet in Org Settings.' })
  const token   = await getGoogleAccessToken()
  if (!token)
    return res.status(503).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not configured on the server.' })

  const rowIdx = await findUserRowIndex(token, phone, sheetId)
  if (rowIdx < 0) return res.status(404).json({ error: 'User not found in sheet.' })

  const delRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIdx - 1, endIndex: rowIdx } } }],
      }),
    }
  )
  if (!delRes.ok) {
    console.error('[delete-user] sheet delete failed:', await delRes.text())
    return res.status(500).json({ error: 'Failed to update the users sheet.' })
  }
  await setDbUserActive(req.user.orgId, normPhone(phone), false)

  writeAudit(req.user.orgId, req.user.uid, req.user.name, 'user.delete', 'user', normPhone(phone), null)

  res.json({ success: true })
})

// ── PATCH /api/set-user-active ────────────────────────────────────────────────
router.patch('/set-user-active', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'Admin role required.' })

  const { phone, active } = req.body || {}
  if (!phone?.trim()) return res.status(400).json({ error: 'phone is required.' })

  const sheetId = await resolveUsersSheetId(req.user)
  if (!sheetId)
    return res.status(400).json({ error: 'User management is not set up for this organization yet. Ask your superadmin to configure a users sheet in Org Settings.' })
  const token   = await getGoogleAccessToken()
  if (!token) return res.status(503).json({ error: 'Service account not configured.' })

  await ensureHeaders(token, sheetId)
  const rowIdx = await findUserRowIndex(token, phone, sheetId)
  if (rowIdx < 0) return res.status(404).json({ error: 'User not found.' })

  const val = active === false || active === 'FALSE' ? 'FALSE' : 'TRUE'
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${USERS_SHEET_NAME}!G${rowIdx}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[val]] }) }
  )
  if (!r.ok) {
    console.error('[set-user-active] sheet update failed:', await r.text())
    return res.status(500).json({ error: 'Failed to update the users sheet.' })
  }
  await setDbUserActive(req.user.orgId, normPhone(phone), val === 'TRUE')

  writeAudit(req.user.orgId, req.user.uid, req.user.name,
    val === 'TRUE' ? 'user.activate' : 'user.deactivate', 'user', normPhone(phone), { active: val })

  res.json({ success: true, active: val === 'TRUE' })
})

// ── POST /api/merge-users ─────────────────────────────────────────────────────
// Merges a duplicate (secondary) user into the primary and removes the secondary sheet row.
router.post('/merge-users', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'Admin role required.' })

  const { primaryPhone, secondaryPhone } = req.body || {}
  if (!primaryPhone?.trim() || !secondaryPhone?.trim())
    return res.status(400).json({ error: 'primaryPhone and secondaryPhone are required.' })
  if (normPhone(primaryPhone) === normPhone(secondaryPhone))
    return res.status(400).json({ error: 'Primary and secondary must be different users.' })

  const sheetId = await resolveUsersSheetId(req.user)
  if (!sheetId)
    return res.status(400).json({ error: 'User management is not set up for this organization yet. Ask your superadmin to configure a users sheet in Org Settings.' })
  const token   = await getGoogleAccessToken()
  if (!token) return res.status(503).json({ error: 'Service account not configured.' })

  const primaryIdx   = await findUserRowIndex(token, primaryPhone, sheetId)
  const secondaryIdx = await findUserRowIndex(token, secondaryPhone, sheetId)

  if (primaryIdx < 0)   return res.status(404).json({ error: 'Primary user not found in sheet.' })
  if (secondaryIdx < 0) return res.status(404).json({ error: 'Secondary user not found in sheet.' })

  const delRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: secondaryIdx - 1, endIndex: secondaryIdx } } }],
      }),
    }
  )
  if (!delRes.ok) {
    console.error('[merge-users] sheet write failed:', await delRes.text())
    return res.status(500).json({ error: 'Failed to update the users sheet.' })
  }
  await setDbUserActive(req.user.orgId, normPhone(secondaryPhone), false)

  writeAudit(req.user.orgId, req.user.uid, req.user.name, 'user.merge', 'user', normPhone(primaryPhone),
    { secondaryPhone: normPhone(secondaryPhone), note: 'Secondary user row removed from sheet' })

  res.json({ success: true, merged: normPhone(secondaryPhone), into: normPhone(primaryPhone) })
})

// ── POST /api/analytics/worker (SSE) ─────────────────────────────────────────
router.post('/analytics/worker', async (req, res) => {
  setupSSE(res)
  const send = (p) => sendSSE(res, p)
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim()
    if (!apiKey) { send({ error: 'GEMINI_API_KEY not set' }); res.end(); return }
    const signal = makeAbortSignal(req)
    const { workerName, reports: _workerReports = [], viewerRole = 'admin' } = req.body || {}
    // Cap token usage
    const reports = _workerReports.slice(0, 2000)
    const n = reports.length
    if (!n) { send({ text: 'No reports found for this worker.' }); res.write('data: [DONE]\n\n'); res.end(); return }

    // ── Core aggregates ────────────────────────────────────────────────────────
    const sorted = [...reports].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    const totalBenef = reports.reduce((s, r) => s + (parseInt(String(r.beneficiaries ?? 0)) || 0), 0)
    const benefValues = reports.map(r => parseInt(String(r.beneficiaries ?? 0)) || 0)
    const avgBenef = n ? Math.round(totalBenef / n) : 0
    const maxBenef = Math.max(...benefValues)
    const minBenef = Math.min(...benefValues)
    const zeroBenefCount = benefValues.filter(v => v === 0).length

    const areaCounts = {}, projectCounts = {}, locationCounts = {}, stateCounts = {}
    reports.forEach(r => {
      if (r.areaOfIntervention) areaCounts[r.areaOfIntervention]   = (areaCounts[r.areaOfIntervention]   || 0) + 1
      if (r.project)            projectCounts[r.project]           = (projectCounts[r.project]           || 0) + 1
      if (r.location)           locationCounts[r.location]         = (locationCounts[r.location]         || 0) + 1
      if (r.state)              stateCounts[r.state]               = (stateCounts[r.state]               || 0) + 1
    })

    const byDay = {}
    reports.forEach(r => { const d = String(r.timestamp).slice(0, 10); if (d) byDay[d] = (byDay[d] || 0) + 1 })
    const activeDays = Object.keys(byDay).length
    const firstDate  = sorted[0]   ? String(sorted[0].timestamp).slice(0, 10)   : 'unknown'
    const lastDate   = sorted[n-1] ? String(sorted[n-1].timestamp).slice(0, 10) : 'unknown'
    const burstDays  = Object.entries(byDay).filter(([, c]) => c >= 3).map(([d, c]) => `${d} (${c} reports)`)

    let maxGap = 0, currentGap = 0, longestGapEnd = ''
    if (firstDate !== 'unknown' && lastDate !== 'unknown') {
      const start = new Date(firstDate), end = new Date(lastDate)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10)
        if (!byDay[key]) { currentGap++; if (currentGap > maxGap) { maxGap = currentGap; longestGapEnd = key } }
        else currentGap = 0
      }
    }

    const now = new Date()
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30)
    const d7  = new Date(now); d7.setDate(d7.getDate() - 7)
    const last30 = reports.filter(r => new Date(String(r.timestamp).slice(0, 10)) >= d30).length
    const last7  = reports.filter(r => new Date(String(r.timestamp).slice(0, 10)) >= d7).length
    const prev30 = reports.filter(r => {
      const t = new Date(String(r.timestamp).slice(0, 10))
      const d60 = new Date(now); d60.setDate(d60.getDate() - 60)
      return t >= d60 && t < d30
    }).length

    const anomalies = []
    if (n > 2) {
      const mean = totalBenef / n
      const stdev = Math.sqrt(benefValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n)
      const outlierThreshold = mean + 3 * stdev
      const outliers = reports.filter(r => (parseInt(String(r.beneficiaries ?? 0)) || 0) > outlierThreshold && outlierThreshold > 0)
      if (outliers.length) anomalies.push(`${outliers.length} report(s) with unusually high beneficiary count (>${Math.round(outlierThreshold)}): dates ${outliers.map(r => String(r.timestamp).slice(0, 10)).join(', ')}`)
    }
    const dupKey = {}
    reports.forEach(r => { const k = `${String(r.timestamp).slice(0,10)}|${r.areaOfIntervention}|${r.location}`; dupKey[k] = (dupKey[k] || 0) + 1 })
    const dups = Object.entries(dupKey).filter(([, c]) => c > 1)
    if (dups.length) anomalies.push(`${dups.length} possible duplicate submission(s) — same date, area, and location filed more than once`)
    if (prev30 > 0 && last30 < prev30 * 0.5) anomalies.push(`Significant drop in reporting: ${last30} reports in last 30 days vs ${prev30} in the prior 30 days (${Math.round((1 - last30/prev30)*100)}% decline)`)
    if (zeroBenefCount > n * 0.4) anomalies.push(`${zeroBenefCount} of ${n} reports (${Math.round(zeroBenefCount/n*100)}%) have zero beneficiaries recorded — possible data entry gaps`)
    if (burstDays.length) anomalies.push(`Bulk submission detected on: ${burstDays.join('; ')} — verify these were genuinely separate field activities`)

    const withDesc  = reports.filter(r => String(r.description || '').length >= 30).length
    const withBenef = reports.filter(r => parseInt(String(r.beneficiaries ?? 0)) > 0).length
    const withPhoto = reports.filter(r => r.attachmentUrl).length
    const withLoc   = reports.filter(r => (r.location || '').trim().split(/\s+/).length >= 2).length
    const pct = (a, b) => b ? `${Math.round(a/b*100)}%` : '0%'

    const recentSamples = sorted.slice(-8).map((r, i) =>
      `${i+1}. [${String(r.timestamp).slice(0,10)} | ${r.areaOfIntervention || '?'} | ${r.location || '?'} | benef: ${r.beneficiaries ?? 0}]\n   "${String(r.description || '(blank)').slice(0, 250)}"`
    ).join('\n\n')
    const earlySamples = sorted.slice(0, 4).map((r, i) =>
      `${i+1}. [${String(r.timestamp).slice(0,10)}] "${String(r.description || '(blank)').slice(0, 200)}"`
    ).join('\n\n')

    const mid = Math.floor(n / 2)
    const earlyDescLen  = sorted.slice(0, mid).reduce((s, r) => s + String(r.description || '').length, 0) / Math.max(mid, 1)
    const recentDescLen = sorted.slice(mid).reduce((s, r) => s + String(r.description || '').length, 0) / Math.max(n - mid, 1)
    const descLenTrend  = recentDescLen < earlyDescLen * 0.7 ? 'declining (possible disengagement)'
      : recentDescLen > earlyDescLen * 1.3 ? 'improving' : 'stable'

    const prompt = `You are conducting a comprehensive performance review of ${workerName}.
This analysis applies universally — the person may work in field operations, community mobilisation (CRP), management, IT, administration, finance, HR, or any other function. Interpret all data accordingly based on what their activity descriptions reveal about their role.

═══════════════════════ ACTIVITY DATA ═══════════════════════

REPORTING PERIOD: ${firstDate} to ${lastDate}
TOTAL ENTRIES: ${n} across ${activeDays} active days

VOLUME TREND:
  Last 7 days:   ${last7} entries
  Last 30 days:  ${last30} entries
  Prior 30 days: ${prev30} entries
  Change: ${prev30 > 0 ? `${last30 > prev30 ? '+' : ''}${Math.round((last30 - prev30) / prev30 * 100)}%` : 'no prior data'}

SUBMISSION PATTERN:
  Longest inactive gap: ${maxGap} consecutive days${longestGapEnd ? ` (ending ${longestGapEnd})` : ''}
  Bulk submission days (3+ entries): ${burstDays.length > 0 ? burstDays.join('; ') : 'none'}

OUTREACH / PEOPLE REACHED:
  Total: ${totalBenef}
  Average per entry: ${avgBenef}
  Min: ${minBenef} | Max: ${maxBenef}
  Entries with zero outreach count: ${zeroBenefCount} of ${n} (${pct(zeroBenefCount, n)})

WORK CATEGORIES (frequency):
${Object.entries(areaCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${k}: ${v} (${pct(v,n)})`).join('\n') || '  none recorded'}

PROJECTS / PROGRAMMES:
${Object.entries(projectCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${k}: ${v} entries`).join('\n') || '  none recorded'}

REGIONS / STATES:
${Object.entries(stateCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${k}: ${v} entries`).join('\n') || '  none recorded'}

WORK SITES / LOCATIONS:
${Object.entries(locationCounts).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`  ${k}: ${v}`).join('\n') || '  none recorded'}

DOCUMENTATION QUALITY:
  Description filled (≥30 chars):  ${withDesc}/${n} (${pct(withDesc,n)})
  Outreach count filled:            ${withBenef}/${n} (${pct(withBenef,n)})
  Photo / attachment included:      ${withPhoto}/${n} (${pct(withPhoto,n)})
  Specific site / location given:   ${withLoc}/${n} (${pct(withLoc,n)})

DESCRIPTION LENGTH TREND:
  Early period average:  ${Math.round(earlyDescLen)} characters
  Recent period average: ${Math.round(recentDescLen)} characters
  Trend: ${descLenTrend}

ANOMALIES PRE-DETECTED:
${anomalies.length ? anomalies.map((a,i)=>`  ${i+1}. ${a}`).join('\n') : '  None automatically detected'}

EARLY ENTRY SAMPLES (first 4 — tone baseline):
${earlySamples}

RECENT ENTRY SAMPLES (last 8 — current tone and task context):
${recentSamples}

═══════════════════════ ANALYSIS TASK ═══════════════════════

${viewerRole === 'employee' ? `
Write directly TO ${workerName} about their own work. Use "you / your" throughout.
Adapt your language to whatever role their descriptions reveal — do not assume they are a field worker. They may be in management, IT, CRP, administration, or any other function.
Use exactly these section headings (with the emoji):

📊 Your Activity This Period
💪 What You Are Doing Well
📉 Where You Can Improve
⚠️ Watch-Outs for You
🔍 Patterns in Your Data
🧠 Your Wellbeing Check
🔄 Your Task Progress & Focus
📝 Your Summary
✅ Your Action Plan

` : viewerRole === 'manager' ? `
Write FOR a manager reviewing their team member ${workerName}. Use "this person / they / their" throughout.
Use exactly these section headings (with the emoji):

📊 Activity Overview
💪 Strengths to Build On
📉 Coaching Needs
⚠️ Risk Flags
🔍 Data Anomalies
🧠 Sentiment & Burnout Signals
🔄 Task Progress & Bottleneck Detection
📝 Objective Summary
✅ Management Actions

` : `
Write FOR an admin or senior reviewer assessing ${workerName}'s data.
Use exactly these section headings (with the emoji):

📊 Activity Overview
💪 Compliance & Performance Positives
📉 Compliance Gaps & Performance Issues
⚠️ Risk Flags
🔍 Data Anomalies
🧠 Sentiment & Wellbeing Indicators
🔄 Task Progress & Bottleneck Detection
📝 Objective Performance Summary
✅ Recommended Actions
`}

Be direct, specific, and evidence-based. Cite numbers. Keep each section to 2-4 bullet points or sentences — no padding. Never write generic statements.`

    const analyticsSys = 'You are a rigorous organisational performance analyst. Your analysis is evidence-based, role-adaptive, and comprehensive. Write detailed, specific sections — cite every number. Flag all data integrity issues and anomalies. Never fabricate data.'
    trackUsage(req.user?.orgId, { service: 'worker_analytics', model: 'flash', inputLength: prompt.length + analyticsSys.length, maxOutputTokens: 0 })
    await callGeminiNotebook(apiKey, prompt, analyticsSys, res, 8192, 0.3, null, 0, signal)
  } catch (e) { send({ error: e instanceof Error ? e.message : 'Error' }); res.end() }
})

export default router
