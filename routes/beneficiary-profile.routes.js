// routes/beneficiary-profile.routes.js
//
// Single-beneficiary profile: resolves a UID to its registry row (IB-/EB-/CB-
// prefix) and joins every beneficiary-linked MIS category, resources and
// linked projects. Campaign is excluded — it has no beneficiary link.
//
//   GET  /api/beneficiary-profile/:uid                — full record + MIS + linked projects
//   PUT  /api/beneficiary-profile/:uid                 — edit the master record's own fields (admin/superadmin only)
//   GET  /api/beneficiary-profile/:uid/export.pdf      — same record as a downloadable PDF
//   PUT  /api/beneficiary-profile/:uid/projects        — replace the set of linked projects
//   POST /api/beneficiary-profile/:uid/mis/:category   — add ONE intervention record directly
//   GET  /api/beneficiary-profile/:uid/qrcode          — PNG QR code linking to this profile

import { Router } from 'express'
import QRCode from 'qrcode'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { buildBeneficiaryProfilePdf } from '../lib/beneficiaryProfilePdf.js'
import { writeAudit } from '../lib/auditMiddleware.js'
import { decryptRowInPlace, encryptMappedFields } from '../lib/piiCrypto.js'

const EXPORT_PURPOSES = ['dsr_fulfillment', 'field_verification', 'donor_report']

const router = Router()

// Same UID-prefix routing as each MIS route's beneficiaryLookupSpec, but
// selects the full row.
function beneficiaryLookupSpec(uid) {
  const u = String(uid || '').trim().toUpperCase()
  if (u.startsWith('IB-')) {
    return { normalizedUid: u, type: 'Individual Beneficiary', table: 'individual_beneficiaries' }
  }
  if (u.startsWith('EB-')) {
    return { normalizedUid: u, type: 'Micro-Entrepreneur', table: 'micro_entrepreneurs' }
  }
  if (u.startsWith('CB-')) {
    return { normalizedUid: u, type: 'Collective', table: 'collectives' }
  }
  if (u.startsWith('XB-')) {
    return { normalizedUid: u, type: 'Indirect Beneficiary', table: 'indirect_beneficiaries' }
  }
  return null
}

// Beneficiary-linked MIS category tables (Campaign excluded, see header).
const MIS_CATEGORIES = [
  { key: 'training',                    table: 'trainings',                      dateCol: 'training_date' },
  // Income has no per-record date (financial_year is a text range), so
  // created_at stands in for ordering.
  { key: 'income',                      table: 'income',                         dateCol: 'created_at' },
  { key: 'inputDistribution',           table: 'input_distributions',            dateCol: 'distribution_date' },
  { key: 'schemeAccess',                table: 'scheme_access',                  dateCol: 'access_date' },
  { key: 'creditGrantAccess',           table: 'credit_grant_access',            dateCol: 'access_date' },
  { key: 'businessDevelopmentSupport',  table: 'business_development_support',   dateCol: 'support_date' },
  { key: 'complianceSupport',           table: 'compliance_support',             dateCol: 'support_date' },
  { key: 'exposureVisit',               table: 'exposure_visits',                dateCol: 'visit_date' },
]

// Shared by the JSON GET and export.pdf. Returns null when the UID doesn't
// resolve to a row.
async function loadFullProfile(pool, orgId, spec) {
  const { rows: profileRows } = await pool.query(
    `SELECT * FROM ${spec.table} WHERE org_id = $1 AND uid = $2`,
    [orgId, spec.normalizedUid]
  )
  const profile = profileRows[0]
  if (!profile) return null
  decryptRowInPlace(spec.table, profile)// no-op for tables/rows with nothing encrypted
  delete profile.org_id // internal id, not part of "beneficiary detail"

  const misResults = await Promise.all(
    MIS_CATEGORIES.map(({ table, dateCol }) =>
      pool.query(
        `SELECT * FROM ${table} WHERE org_id = $1 AND beneficiary_uid = $2 ORDER BY ${dateCol} DESC NULLS LAST, created_at DESC`,
        [orgId, spec.normalizedUid]
      )
    )
  )

  // Resolve each row's project_key to a display name, falling back to the raw
  // key if the plan was deleted.
  const { rows: planRows } = await pool.query(
    `SELECT project_key, name FROM action_plans WHERE org_id = $1`,
    [orgId]
  )
  const projectNameByKey = new Map(planRows.map(p => [p.project_key, p.name]))

  const mis = {}
  MIS_CATEGORIES.forEach(({ key }, i) => {
    mis[key] = misResults[i].rows.map(r => ({
      ...r,
      project_name: projectNameByKey.get(r.project_key) || r.project_key,
    }))
  })
  const misRecordCount = MIS_CATEGORIES.reduce((sum, { key }) => sum + mis[key].length, 0)

  // Projects = manual links (beneficiary_project_links, which nothing in the UI
  // writes today) UNION every project_key the beneficiary has MIS rows under.
  const { rows: linkRows } = await pool.query(
    `SELECT project_key FROM beneficiary_project_links WHERE org_id = $1 AND beneficiary_uid = $2`,
    [orgId, spec.normalizedUid]
  )
  const projectKeys = new Set(linkRows.map(r => r.project_key))
  MIS_CATEGORIES.forEach(({ key }) => {
    mis[key].forEach(r => { if (r.project_key) projectKeys.add(r.project_key) })
  })

  const { rows: resourceRows } = await pool.query(
    `SELECT id, uid, resource_type, latitude, longitude, area_acre,
            water_body_type, resource_access, wetland_structure, raft_count,
            resource_utility, created_at
     FROM resources WHERE org_id = $1 AND beneficiary_uid = $2 ORDER BY created_at DESC`,
    [orgId, spec.normalizedUid]
  )

  return {
    uid: spec.normalizedUid,
    type: spec.type,
    profile,
    mis,
    misRecordCount,
    // Falls back to the raw key when the plan was deleted.
    projects: [...projectKeys]
      .map(key => ({ project_key: key, name: projectNameByKey.get(key) || key }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    resources: resourceRows,
  }
}

// GET /api/beneficiary-profile/:uid
router.get('/beneficiary-profile/:uid', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool  = getPool()
    const orgId = req.user.orgId
    const spec  = beneficiaryLookupSpec(req.params.uid)
    if (!spec) {
      return res.status(400).json({ error: `UID "${req.params.uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)` })
    }

    const payload = await loadFullProfile(pool, orgId, spec)
    if (!payload) {
      return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })
    }
    res.json(payload)
  } catch (e) {
    console.error('[beneficiary-profile GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/beneficiary-profile/:uid
// Partial patch of the master record's own fields. Admin-only, since this can
// alter a beneficiary's registered identity. Unknown and PROTECTED_COLUMNS
// keys are silently ignored; column names come from the DB row, not the
// request, so the dynamic SET clause has no injection surface.
const PROTECTED_COLUMNS = new Set(['id', 'uid', 'org_id', 'created_at'])

router.put('/beneficiary-profile/:uid', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const pool  = getPool()
    const orgId = req.user.orgId
    const spec  = beneficiaryLookupSpec(req.params.uid)
    if (!spec) {
      return res.status(400).json({ error: `UID "${req.params.uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)` })
    }

    const { rows: existingRows } = await pool.query(
      `SELECT * FROM ${spec.table} WHERE org_id = $1 AND uid = $2`,
      [orgId, spec.normalizedUid]
    )
    const existing = existingRows[0]
    if (!existing) {
      return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })
    }

    const rawUpdates = req.body?.profile
    if (!rawUpdates || typeof rawUpdates !== 'object' || Array.isArray(rawUpdates)) {
      return res.status(400).json({ error: 'profile object required' })
    }

    // Filter on plaintext-named columns (what clients send); encryptMappedFields
    // then maps PII fields to their _enc/_hash columns and nulls the plaintext.
    const preFilterEntries = Object.entries(rawUpdates).filter(
      ([key]) => Object.prototype.hasOwnProperty.call(existing, key) && !PROTECTED_COLUMNS.has(key)
    )
    if (!preFilterEntries.length) {
      return res.status(400).json({ error: 'No editable fields supplied' })
    }
    const updates = encryptMappedFields(spec.table, Object.fromEntries(preFilterEntries))

    const setEntries = Object.entries(updates)
    const setClause = setEntries.map(([key], i) => `"${key}" = $${i + 3}`).join(', ')
    // node-postgres binds a JS array as a Postgres ARRAY literal, which breaks
    // jsonb columns; stringify objects/arrays so they bind as jsonb text.
    const values = setEntries.map(([, value]) => (
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value
    ))
    await pool.query(
      `UPDATE ${spec.table} SET ${setClause} WHERE org_id = $1 AND uid = $2`,
      [orgId, spec.normalizedUid, ...values]
    )

    const payload = await loadFullProfile(pool, orgId, spec)
    res.json(payload)
  } catch (e) {
    console.error('[beneficiary-profile PUT]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/beneficiary-profile/:uid/export.pdf?purpose=dsr_fulfillment|field_verification|donor_report
// Full PII dossier as PDF, so `purpose` is required, every export is
// audit-logged, and the PDF is watermarked with who/when/why.
router.get('/beneficiary-profile/:uid/export.pdf', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const purpose = req.query.purpose
    if (!EXPORT_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `?purpose= is required and must be one of: ${EXPORT_PURPOSES.join(', ')}` })
    }

    const pool  = getPool()
    const orgId = req.user.orgId
    const spec  = beneficiaryLookupSpec(req.params.uid)
    if (!spec) {
      return res.status(400).json({ error: `UID "${req.params.uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)` })
    }

    const payload = await loadFullProfile(pool, orgId, spec)
    if (!payload) {
      return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })
    }

    // Best-effort branding; a blank org_name falls back to "FieldFlow".
    const { rows: orgRows } = await pool.query(
      `SELECT metadata->'branding'->>'org_name' AS org_name FROM organizations WHERE id = $1`,
      [orgId]
    )
    const orgName = orgRows[0]?.org_name || null

    // req.user carries no display name, only uid/orgId/role from custom claims.
    const buffer = await buildBeneficiaryProfilePdf(payload, orgName, {
      exportedByName: req.user.uid,
      purpose,
    })
    writeAudit({
      orgId, actorUid: req.user.uid, action: 'beneficiary.export_pdf',
      targetType: 'beneficiary', targetId: spec.normalizedUid,
      diff: { purpose, requestId: req.query.dsrRequestId || null },
      requestId: req.query.dsrRequestId || null,
    })
    const displayName = payload.profile.collective_name ?? payload.profile.name ?? payload.uid
    const safeName = String(displayName).replace(/[^a-zA-Z0-9_-]/g, '_')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${spec.normalizedUid}_profile.pdf"`)
    res.send(buffer)
  } catch (e) {
    console.error('[beneficiary-profile export.pdf]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// PUT /api/beneficiary-profile/:uid/projects
// Body: { projectKeys: string[] } — replaces the full set (checkbox-list
// editor always submits its complete selection).
router.put('/beneficiary-profile/:uid/projects', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool  = getPool()
    const orgId = req.user.orgId
    const spec  = beneficiaryLookupSpec(req.params.uid)
    if (!spec) {
      return res.status(400).json({ error: `UID "${req.params.uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)` })
    }

    const { rows: existing } = await pool.query(
      `SELECT 1 FROM ${spec.table} WHERE org_id = $1 AND uid = $2`,
      [orgId, spec.normalizedUid]
    )
    if (!existing.length) {
      return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })
    }

    const projectKeys = Array.isArray(req.body?.projectKeys)
      ? [...new Set(req.body.projectKeys.map(k => String(k || '').trim()).filter(Boolean))]
      : null
    if (projectKeys === null) {
      return res.status(400).json({ error: 'projectKeys[] required (may be empty to unlink all projects)' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `DELETE FROM beneficiary_project_links WHERE org_id = $1 AND beneficiary_uid = $2`,
        [orgId, spec.normalizedUid]
      )
      for (const projectKey of projectKeys) {
        await client.query(
          `INSERT INTO beneficiary_project_links (org_id, beneficiary_uid, beneficiary_type, project_key, linked_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, beneficiary_uid, project_key) DO NOTHING`,
          [orgId, spec.normalizedUid, spec.type, projectKey, req.user.name || 'unknown']
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    const { rows: projectRows } = await pool.query(
      `SELECT bpl.project_key, ap.name
       FROM beneficiary_project_links bpl
       LEFT JOIN action_plans ap ON ap.org_id = bpl.org_id AND ap.project_key = bpl.project_key
       WHERE bpl.org_id = $1 AND bpl.beneficiary_uid = $2
       ORDER BY bpl.created_at`,
      [orgId, spec.normalizedUid]
    )
    res.json({
      uid: spec.normalizedUid,
      projects: projectRows.map(r => ({ project_key: r.project_key, name: r.name || r.project_key })),
    })
  } catch (e) {
    console.error('[beneficiary-profile PUT projects]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Add one intervention record directly from the profile ─────────────────
// Single-record counterpart to each MIS category's bulk Excel upload. The
// beneficiary is already known, so its uid/type/name/contact_no are reused.
// Body keys are literal DB column names (see AddInterventionModal.tsx's
// INTERVENTION_CATEGORIES).
function toNullableNumber(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return n
}

function toDateOrNull(v) {
  if (!v) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

const MIS_WRITERS = {
  training: {
    table: 'trainings', requiredLabel: 'Training topic',
    fields: [
      { col: 'training_topic', type: 'text', required: true },
      { col: 'training_date', type: 'date' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'training_topic', 'training_date'],
  },
  inputDistribution: {
    table: 'input_distributions', requiredLabel: 'Input distributed',
    fields: [
      { col: 'input_distributed', type: 'text', required: true },
      { col: 'distribution_date', type: 'date' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'input_distributed', 'distribution_date'],
  },
  schemeAccess: {
    table: 'scheme_access', requiredLabel: 'Scheme',
    fields: [
      { col: 'scheme_name', type: 'text', required: true },
      { col: 'access_date', type: 'date' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'scheme_name', 'access_date'],
  },
  creditGrantAccess: {
    table: 'credit_grant_access', requiredLabel: 'Credit/Grant source',
    fields: [
      { col: 'credit_grant_source', type: 'text', required: true },
      { col: 'credit_grant_type', type: 'text' },
      { col: 'entity_name', type: 'text' },
      { col: 'amount', type: 'number' },
      { col: 'access_date', type: 'date' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'credit_grant_source', 'entity_name', 'access_date'],
  },
  businessDevelopmentSupport: {
    table: 'business_development_support', requiredLabel: 'Support provided',
    fields: [
      { col: 'support_provided', type: 'text', required: true },
      { col: 'support_date', type: 'date' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'support_provided', 'support_date'],
  },
  complianceSupport: {
    table: 'compliance_support', requiredLabel: 'Compliance support provided',
    fields: [
      { col: 'compliance_support_provided', type: 'text', required: true },
      { col: 'support_date', type: 'date' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'compliance_support_provided', 'support_date'],
  },
  exposureVisit: {
    table: 'exposure_visits', requiredLabel: 'Purpose of exposure visit',
    fields: [
      { col: 'purpose', type: 'text', required: true },
      { col: 'visit_place', type: 'text' },
      { col: 'visit_date', type: 'date' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'purpose', 'visit_date'],
  },
  income: {
    table: 'income', requiredLabel: 'Financial year',
    fields: [
      { col: 'financial_year', type: 'text', required: true },
      { col: 'income_source', type: 'text', required: true },
      { col: 'income_realised', type: 'number' },
      { col: 'place', type: 'text' },
    ],
    conflictCols: ['org_id', 'project_key', 'beneficiary_uid', 'financial_year', 'income_source'],
  },
}

// POST /api/beneficiary-profile/:uid/mis/:category
// Body: { project_key, ...<that category's field columns> }
router.post('/beneficiary-profile/:uid/mis/:category', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const writer = MIS_WRITERS[req.params.category]
    if (!writer) {
      return res.status(400).json({ error: `Unknown intervention category "${req.params.category}"` })
    }

    const pool  = getPool()
    const orgId = req.user.orgId
    const spec  = beneficiaryLookupSpec(req.params.uid)
    if (!spec) {
      return res.status(400).json({ error: `UID "${req.params.uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)` })
    }

    const { rows: beneficiaryRows } = await pool.query(
      `SELECT * FROM ${spec.table} WHERE org_id = $1 AND uid = $2`,
      [orgId, spec.normalizedUid]
    )
    const beneficiary = beneficiaryRows[0]
    if (!beneficiary) {
      return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })
    }

    const projectKey = String(req.body?.project_key || '').trim()
    if (!projectKey) return res.status(400).json({ error: 'project_key required' })

    const values = {}
    for (const f of writer.fields) {
      const raw = req.body?.[f.col]
      if (f.type === 'date') values[f.col] = toDateOrNull(raw)
      else if (f.type === 'number') values[f.col] = toNullableNumber(raw)
      else values[f.col] = raw != null ? (String(raw).trim() || null) : null

      if (f.required && !values[f.col]) {
        return res.status(400).json({ error: `${writer.requiredLabel} is required` })
      }
      if (f.type === 'number' && values[f.col] != null && Number.isNaN(values[f.col])) {
        return res.status(400).json({ error: `${writer.requiredLabel} form has an invalid number` })
      }
    }

    // collective_name for Collective, name for everything else.
    const beneficiaryName = beneficiary.name ?? beneficiary.collective_name ?? null
    const contactNo = beneficiary.contact_no ?? null

    const cols = ['org_id', 'project_key', 'beneficiary_uid', 'beneficiary_type', 'beneficiary_name', 'contact_no',
      ...writer.fields.map(f => f.col), 'uploaded_by']
    const vals = [orgId, projectKey, spec.normalizedUid, spec.type, beneficiaryName, contactNo,
      ...writer.fields.map(f => values[f.col]), req.user.name || 'unknown']
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(',')
    const updateAssignments = [
      'beneficiary_name = $5', 'contact_no = $6',
      ...writer.fields
        .filter(f => !writer.conflictCols.includes(f.col))
        .map(f => `${f.col} = $${cols.indexOf(f.col) + 1}`),
      `uploaded_by = $${vals.length}`,
    ].join(', ')

    const { rows } = await pool.query(
      `INSERT INTO ${writer.table} (${cols.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (${writer.conflictCols.join(', ')}) DO UPDATE SET ${updateAssignments}
       RETURNING *`,
      vals
    )

    const { rows: planRows } = await pool.query(
      `SELECT name FROM action_plans WHERE org_id = $1 AND project_key = $2`,
      [orgId, projectKey]
    )
    res.status(201).json({
      ok: true,
      record: { ...rows[0], project_name: planRows[0]?.name || projectKey },
    })
  } catch (e) {
    console.error('[beneficiary-profile POST mis]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Prefer an explicit env var over the request's Host header, which is wrong
// behind a custom domain/CDN/Hosting rewrite that doesn't forward Host. The
// request fallback keeps local dev working.
function resolveAppBaseUrl(req) {
  const configured = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '')
  if (configured) return configured
  return `${req.protocol}://${req.get('host')}`
}

// GET /api/beneficiary-profile/:uid/qrcode
// PNG QR encoding a plain-path deep link (`/beneficiary/<uid>`, not a hash
// route) for printed ID cards. It carries no auth info; opening it still goes
// through normal login.
router.get('/beneficiary-profile/:uid/qrcode', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool  = getPool()
    const orgId = req.user.orgId
    const spec  = beneficiaryLookupSpec(req.params.uid)
    if (!spec) {
      return res.status(400).json({ error: `UID "${req.params.uid}" must start with IB- (Individual Beneficiary), EB- (Micro-Entrepreneur), CB- (Collective) or XB- (Indirect Beneficiary)` })
    }

    const { rows } = await pool.query(
      `SELECT 1 FROM ${spec.table} WHERE org_id = $1 AND uid = $2`,
      [orgId, spec.normalizedUid]
    )
    if (!rows.length) {
      return res.status(404).json({ error: `No ${spec.type} found for UID "${spec.normalizedUid}"` })
    }

    const size = Math.min(1024, Math.max(128, parseInt(req.query.size, 10) || 480))
    const deepLink = `${resolveAppBaseUrl(req)}/beneficiary/${encodeURIComponent(spec.normalizedUid)}`
    const png = await QRCode.toBuffer(deepLink, { type: 'png', width: size, margin: 2 })

    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'private, max-age=3600')
    res.send(png)
  } catch (e) {
    console.error('[beneficiary-profile GET qrcode]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
