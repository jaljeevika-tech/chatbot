// DPDP consent capture. Staff-mediated: staff record a grant/withdrawal after asking
// the beneficiary (or a minor's guardian) in person; beneficiaries have no login.
//
//   POST /api/consent                          — record a grant/withdrawal
//   GET  /api/consent/:beneficiaryUid          — full history, newest first
//   GET  /api/consent/:beneficiaryUid/status   — latest status per purpose
//
// A minor's photo_video / named_attribution consent must be
// granted_by='parent_guardian'. is_minor comes from 061; collectives have no single
// data subject, so they're skipped.

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { resolveBeneficiaryType, BENEFICIARY_UID_PREFIX_HINT } from '../lib/beneficiaryLookup.js'
import { getConsentHistory, getConsentSummary, VALID_PURPOSES } from '../lib/consent.js'

const router = Router()

const IS_MINOR_TABLES = {
  'Individual Beneficiary': 'individual_beneficiaries',
  'Micro-Entrepreneur':     'micro_entrepreneurs',
  // Per-project beneficiaries have no stable cross-project UID, and collectives
  // aren't data subjects, so neither is looked up.
}

async function isMinor(orgId, type, normalizedUid) {
  const table = IS_MINOR_TABLES[type]
  if (!table) return false // unknown / Collective — no minor concept to enforce
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT is_minor FROM ${table} WHERE org_id = $1 AND uid = $2 LIMIT 1`,
      [orgId, normalizedUid]
    )
    return rows[0]?.is_minor === true
  } catch (e) {
    console.warn('[consent] isMinor lookup failed:', e.message)
    // Can't confirm an adult → require guardian consent.
    return true
  }
}

// POST /api/consent — record a grant or withdrawal
router.post('/consent', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { beneficiaryUid, purpose, status, grantedBy, method, notes } = req.body || {}

    const spec = resolveBeneficiaryType(beneficiaryUid)
    if (!spec) return res.status(400).json({ error: BENEFICIARY_UID_PREFIX_HINT })
    if (!VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `purpose must be one of: ${VALID_PURPOSES.join(', ')}` })
    }
    if (!['granted', 'withdrawn'].includes(status)) {
      return res.status(400).json({ error: "status must be 'granted' or 'withdrawn'" })
    }
    const granted_by = grantedBy === 'parent_guardian' ? 'parent_guardian' : 'self'

    // Minors: photo_video / named_attribution must come from a parent/guardian
    if ((purpose === 'photo_video' || purpose === 'named_attribution') && granted_by === 'self') {
      if (await isMinor(req.user.orgId, spec.type, spec.normalizedUid)) {
        return res.status(400).json({
          error: `${spec.type} ${spec.normalizedUid} is recorded as a minor — ${purpose} consent must be granted_by='parent_guardian', not 'self'`,
        })
      }
    }

    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO consent_records
         (org_id, beneficiary_uid, beneficiary_type, purpose, status, granted_by, recorded_by_uid, recorded_by_name, method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, beneficiary_uid, beneficiary_type, purpose, status, granted_by, method, notes, created_at`,
      [
        req.user.orgId, spec.normalizedUid, spec.type, purpose, status, granted_by,
        req.user.uid, req.user.name || '', method || null, notes || null,
      ]
    )
    res.json(rows[0])
  } catch (e) {
    console.error('[consent POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/consent/:beneficiaryUid — full grant/withdraw history
router.get('/consent/:beneficiaryUid', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const spec = resolveBeneficiaryType(req.params.beneficiaryUid)
    if (!spec) return res.status(400).json({ error: BENEFICIARY_UID_PREFIX_HINT })
    const history = await getConsentHistory(req.user.orgId, spec.normalizedUid)
    res.json({ beneficiaryUid: spec.normalizedUid, beneficiaryType: spec.type, history })
  } catch (e) {
    console.error('[consent history GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/consent/:beneficiaryUid/status — latest status per purpose
router.get('/consent/:beneficiaryUid/status', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const spec = resolveBeneficiaryType(req.params.beneficiaryUid)
    if (!spec) return res.status(400).json({ error: BENEFICIARY_UID_PREFIX_HINT })
    const summary = await getConsentSummary(req.user.orgId, spec.normalizedUid)
    res.json({ beneficiaryUid: spec.normalizedUid, beneficiaryType: spec.type, status: summary })
  } catch (e) {
    console.error('[consent status GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
