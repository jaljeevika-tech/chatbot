// Read-only lookups over the LGD (Local Government Directory) State/District/Block/
// Panchayat/Village tables (035; provenance in db/seed-data/lgd/README.md).
// State/District lists are small and sent whole; Block/Panchayat/Village are
// type-ahead capped at 50 (prefix match, substring for villages).
//
//   GET /api/lgd/states
//   GET /api/lgd/districts[?state=<stateCode>]   (state omitted = all districts)
//   GET /api/lgd/blocks?district=<districtCode>&q=<prefix>
//   GET /api/lgd/panchayats?block=<blockCode>&q=<prefix>
//   GET /api/lgd/villages?panchayat=<panchayatCode>|block=<blockCode>&q=<substring>

import { Router } from 'express'
import { getPool } from '../db/pool.js'

const router = Router()
const TYPEAHEAD_LIMIT = 50

router.get('/lgd/states', async (req, res) => {
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT code, name, is_ut AS "isUt" FROM lgd_states ORDER BY name`
    )
    res.json(rows)
  } catch (e) {
    console.error('[lgd states]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/lgd/districts', async (req, res) => {
  // Without `state`, all 763 districts (small enough to send whole).
  const hasState = req.query.state !== undefined
  const stateCode = parseInt(req.query.state, 10)
  if (hasState && !Number.isFinite(stateCode)) return res.status(400).json({ error: 'state must be a number' })
  try {
    const pool = getPool()
    const { rows } = hasState
      ? await pool.query(`SELECT code, name FROM lgd_districts WHERE state_code = $1 ORDER BY name`, [stateCode])
      : await pool.query(`SELECT code, name FROM lgd_districts ORDER BY name`)
    res.json(rows)
  } catch (e) {
    console.error('[lgd districts]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/lgd/blocks', async (req, res) => {
  const districtCode = parseInt(req.query.district, 10)
  if (!Number.isFinite(districtCode)) return res.status(400).json({ error: 'district (LGD district code) required' })
  const q = String(req.query.q || '').trim()
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT code, name FROM lgd_blocks
       WHERE district_code = $1 ${q ? 'AND name ILIKE $2' : ''}
       ORDER BY name LIMIT ${TYPEAHEAD_LIMIT}`,
      q ? [districtCode, `${q}%`] : [districtCode]
    )
    res.json(rows)
  } catch (e) {
    console.error('[lgd blocks]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/lgd/panchayats', async (req, res) => {
  const blockCode = parseInt(req.query.block, 10)
  if (!Number.isFinite(blockCode)) return res.status(400).json({ error: 'block (LGD block code) required' })
  const q = String(req.query.q || '').trim()
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT code, name FROM lgd_panchayats
       WHERE block_code = $1 ${q ? 'AND name ILIKE $2' : ''}
       ORDER BY name LIMIT ${TYPEAHEAD_LIMIT}`,
      q ? [blockCode, `${q}%`] : [blockCode]
    )
    res.json(rows)
  } catch (e) {
    console.error('[lgd panchayats]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/lgd/villages', async (req, res) => {
  const panchayatCode = parseInt(req.query.panchayat, 10)
  const blockCode = parseInt(req.query.block, 10)
  const scopeCol = Number.isFinite(panchayatCode) ? 'panchayat_code' : Number.isFinite(blockCode) ? 'block_code' : null
  const scopeVal = scopeCol === 'panchayat_code' ? panchayatCode : blockCode
  if (!scopeCol) return res.status(400).json({ error: 'panchayat or block (LGD code) required' })
  const q = String(req.query.q || '').trim()
  try {
    const pool = getPool()
    // Substring match: many villages are named "<Parent> village no:NN", and a prefix
    // match on "no 06" would find nothing, pushing users to free-text duplicates.
    const { rows } = await pool.query(
      `SELECT code, name FROM lgd_villages
       WHERE ${scopeCol} = $1 ${q ? 'AND name ILIKE $2' : ''}
       ORDER BY name LIMIT ${TYPEAHEAD_LIMIT}`,
      q ? [scopeVal, `%${q}%`] : [scopeVal]
    )
    res.json(rows)
  } catch (e) {
    console.error('[lgd villages]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
