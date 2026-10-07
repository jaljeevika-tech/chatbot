// Super admin: per-org form builder (migration 085). Built-in entity forms
// exist virtually until first saved — GET returns the default system-field
// schema. Edits go to forms.draft_schema; publish freezes a form_versions row.
// Every write is in platform_audit_log.
//
// GET  /api/superadmin/org/:id/forms
// GET  /api/superadmin/org/:id/forms/:key
// PUT  /api/superadmin/org/:id/forms/:key           { title?, schema }  → save draft (creates custom form)
// POST /api/superadmin/org/:id/forms/:key/publish
// POST /api/superadmin/org/:id/forms/:key/archive   { archived }        (custom forms only)

import { Router } from 'express'
import { requireSuperAdmin } from '../lib/auth.js'
import { getPool } from '../db/pool.js'
import { auditPlatform } from '../lib/platformAudit.js'
import { ENTITY_FORMS, defaultSchema, normalizeSchema, validateSchema } from '../lib/forms.js'

const router = Router()
router.use('/superadmin', requireSuperAdmin)

const KEY_RE = /^[a-z][a-z0-9_]{1,63}$/
const MIGRATION_085 = 'Database migration 085_forms.sql has not been run yet.'
const isMissingTable = e => e?.code === '42P01' || e?.code === '42703'
const fail = (res, e) => isMissingTable(e)
  ? res.status(503).json({ error: MIGRATION_085 })
  : (console.error('[superadmin-forms]', e), res.status(500).json({ error: 'Something went wrong' }))

async function loadForm(orgId, key) {
  const { rows } = await getPool().query(
    `SELECT f.*, v.schema AS published_schema, v.version AS published_version
       FROM forms f LEFT JOIN form_versions v ON v.id = f.current_version_id
      WHERE f.org_id = $1 AND f.form_key = $2`, [orgId, key])
  return rows[0] || null
}

async function orgExists(orgId) {
  const { rows } = await getPool().query(`SELECT 1 FROM organizations WHERE id = $1`, [orgId])
  return rows.length > 0
}

router.get('/superadmin/org/:id/forms', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT f.form_key, f.kind, f.title, f.archived_at, f.updated_at, f.draft_schema IS NOT NULL AS has_draft,
              v.version AS published_version, v.published_at,
              (SELECT count(*) FROM form_submissions s WHERE s.form_id = f.id)::int AS submissions
         FROM forms f LEFT JOIN form_versions v ON v.id = f.current_version_id
        WHERE f.org_id = $1 ORDER BY f.kind, f.title`, [req.params.id])
    const saved = new Map(rows.map(r => [r.form_key, r]))
    const builtIn = Object.entries(ENTITY_FORMS).map(([key, title]) => saved.get(key) || {
      form_key: key, kind: 'entity', title, archived_at: null, updated_at: null, has_draft: false,
      published_version: null, published_at: null, submissions: 0,
    })
    res.json([...builtIn, ...rows.filter(r => r.kind === 'custom')])
  } catch (e) { fail(res, e) }
})

router.get('/superadmin/org/:id/forms/:key', async (req, res) => {
  const { id: orgId, key } = req.params
  try {
    const f = await loadForm(orgId, key)
    if (!f && !ENTITY_FORMS[key]) return res.status(404).json({ error: 'Form not found' })
    const { rows: versions } = f ? await getPool().query(
      `SELECT v.version, v.published_at, u.name AS published_by
         FROM form_versions v LEFT JOIN users u ON u.id = v.published_by
        WHERE v.form_id = $1 ORDER BY v.version DESC`, [f.id]) : { rows: [] }
    const schema = f?.draft_schema || f?.published_schema || defaultSchema(key)
    const kind = f?.kind || 'entity'
    res.json({
      form_key: key, kind, title: f?.title || ENTITY_FORMS[key], archived_at: f?.archived_at || null,
      schema, has_draft: !!f?.draft_schema, published_version: f?.published_version ?? null, versions,
      published_names: (f?.published_schema?.survey || []).map(r => r.name).filter(Boolean),
      errors: validateSchema(normalizeSchema(schema, kind === 'entity' ? key : null), kind === 'entity' ? key : null, f?.published_schema),
    })
  } catch (e) { fail(res, e) }
})

router.put('/superadmin/org/:id/forms/:key',
  auditPlatform('form.draft.save', 'form', { targetId: req => req.params.key, diff: req => ({ title: req.body?.title, rows: req.body?.schema?.survey?.length }) }),
  async (req, res) => {
    const { id: orgId, key } = req.params
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'Form ID must be 2–64 lowercase letters, digits or _, starting with a letter.' })
    const kind = ENTITY_FORMS[key] ? 'entity' : 'custom'
    const entityKey = kind === 'entity' ? key : null
    const schema = normalizeSchema(req.body?.schema, entityKey)
    const title = String(req.body?.title || schema.settings.form_title || ENTITY_FORMS[key] || '').trim().slice(0, 200)
    if (!title) return res.status(400).json({ error: 'Title is required.' })
    schema.settings.form_title ||= title
    try {
      if (!(await orgExists(orgId))) return res.status(404).json({ error: 'Organization not found' })
      const { rows } = await getPool().query(
        `INSERT INTO forms (org_id, form_key, kind, title, draft_schema)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, form_key) DO UPDATE SET title = EXCLUDED.title, draft_schema = EXCLUDED.draft_schema, updated_at = now()
         RETURNING id`, [orgId, key, kind, title, schema])
      const f = await loadForm(orgId, key)
      res.json({ id: rows[0].id, errors: validateSchema(schema, entityKey, f?.published_schema) })
    } catch (e) { fail(res, e) }
  })

router.post('/superadmin/org/:id/forms/:key/publish',
  auditPlatform('form.publish', 'form', { targetId: req => req.params.key, diff: () => null }),
  async (req, res) => {
    const { id: orgId, key } = req.params
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT f.id, f.kind, f.draft_schema, v.schema AS published_schema
           FROM forms f LEFT JOIN form_versions v ON v.id = f.current_version_id
          WHERE f.org_id = $1 AND f.form_key = $2 FOR UPDATE OF f`, [orgId, key])
      const f = rows[0]
      if (!f?.draft_schema) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nothing to publish — save a draft first.' }) }
      const entityKey = f.kind === 'entity' ? key : null
      const schema = normalizeSchema(f.draft_schema, entityKey)
      const errors = validateSchema(schema, entityKey, f.published_schema)
      if (errors.length) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Fix the problems below before publishing.', errors }) }
      const { rows: [v] } = await client.query(
        `INSERT INTO form_versions (form_id, org_id, version, schema, published_by)
         VALUES ($1, $2, COALESCE((SELECT max(version) FROM form_versions WHERE form_id = $1), 0) + 1, $3,
                 (SELECT id FROM users WHERE firebase_uid = $4 LIMIT 1))
         RETURNING id, version`, [f.id, orgId, schema, req.user?.uid || null])
      await client.query(`UPDATE forms SET current_version_id = $1, draft_schema = NULL, updated_at = now() WHERE id = $2`, [v.id, f.id])
      await client.query('COMMIT')
      res.json({ version: v.version })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      fail(res, e)
    } finally { client.release() }
  })

router.post('/superadmin/org/:id/forms/:key/archive',
  auditPlatform('form.archive', 'form', { targetId: req => req.params.key }),
  async (req, res) => {
    try {
      const { rowCount } = await getPool().query(
        `UPDATE forms SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now()
          WHERE org_id = $1 AND form_key = $2 AND kind = 'custom'`, [req.params.id, req.params.key, !!req.body?.archived])
      if (!rowCount) return res.status(404).json({ error: 'Custom form not found (built-in forms can\'t be archived).' })
      res.json({ ok: true })
    } catch (e) { fail(res, e) }
  })

export default router
