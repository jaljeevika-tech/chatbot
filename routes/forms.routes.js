// Staff side of the form builder: fill published forms (web/PWA, offline queue) and
// read submissions. Custom forms store answers in form_submissions; built-in entity
// forms (beneficiaries, resources) write their real table via lib/entityWriters.js
// and keep only the custom answers in form_submissions (system PII stays encrypted
// in its own columns).
//
// GET  /api/forms                               published forms + schemas (cached offline by the client)
// POST /api/forms/:key/submissions              { instance_id, version, data } — idempotent on instance_id
// GET  /api/forms/:key/submissions              admin/manager: all; employee: own
// GET  /api/forms/:key/media/:mediaId           a photo/audio answer

import { Router } from 'express'
import crypto from 'crypto'
import { getPool } from '../db/pool.js'
import { buildTree, evaluateForm } from '../lib/odkForm.js'
import { withDynamicChoices } from '../lib/forms.js'
import { ENTITY_WRITERS, WRITER_ROLES, WriteError, splitAnswers, writeEntity } from '../lib/entityWriters.js'

const router = Router()

const MEDIA_RE = /^data:((?:image\/(?:jpeg|png|webp))|(?:audio\/(?:mpeg|mp4|aac|ogg|webm|wav|x-m4a|3gpp|amr)));base64,([A-Za-z0-9+/=]+)$/
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const canSeeAll = (req) => ['admin', 'manager', 'superadmin'].includes(req.user.role)
const MIGRATION_085 = 'Database migration 085_forms.sql has not been run yet.'
const fail = (res, e) => (e?.code === '42P01'
  ? res.status(503).json({ error: MIGRATION_085 })
  : (console.error('[forms]', e), res.status(500).json({ error: 'Something went wrong' })))

const canWrite = (req, key) => !!ENTITY_WRITERS[key] && (!WRITER_ROLES[key] || WRITER_ROLES[key].includes(req.user.role))

async function orgProjects(orgId) {
  const { rows } = await getPool().query(`SELECT metadata->'projects' AS projects FROM organizations WHERE id = $1`, [orgId])
  return Array.isArray(rows[0]?.projects) ? rows[0].projects : []
}

async function userId(req) {
  const { rows } = await getPool().query(`SELECT id FROM users WHERE org_id = $1 AND firebase_uid = $2 LIMIT 1`, [req.user.orgId, req.user.uid])
  return rows[0]?.id || null
}

router.get('/forms', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT f.form_key, f.kind, f.title, v.version, v.schema
         FROM forms f JOIN form_versions v ON v.id = f.current_version_id
        WHERE f.org_id = $1 AND f.archived_at IS NULL
        ORDER BY f.kind DESC, f.title`, [req.user.orgId])
    const visible = rows.filter(f => f.kind === 'custom' || canWrite(req, f.form_key))
    const projects = visible.some(f => f.form_key === 'beneficiary') ? await orgProjects(req.user.orgId) : []
    res.json(visible.map(f => (f.kind === 'entity' ? { ...f, schema: withDynamicChoices(f.schema, { projects }) } : f)))
  } catch (e) { fail(res, e) }
})

/** Moves data-URL photo/audio answers out of `data` into media rows; mutates data in place. */
function extractMedia(data, defs) {
  const media = []
  const visit = (obj) => {
    for (const [key, val] of Object.entries(obj)) {
      const type = defs[key]?.row.type
      if (Array.isArray(val) && type === 'begin_repeat') { val.forEach(item => item && typeof item === 'object' && visit(item)); continue }
      if ((type !== 'image' && type !== 'audio') || typeof val !== 'string' || !val.startsWith('data:')) continue
      const m = MEDIA_RE.exec(val)
      if (!m || (type === 'image') !== m[1].startsWith('image/')) throw Object.assign(new Error(`${key}: unsupported file type`), { status: 400 })
      const size = Math.floor(m[2].length * 3 / 4)
      if (size > MAX_MEDIA_BYTES) throw Object.assign(new Error(`${key}: file is larger than 10 MB`), { status: 413 })
      const fileName = `${key}-${crypto.randomUUID()}.${EXT[m[1]] || m[1].split('/')[1].replace('x-', '')}`
      media.push({ fileName, contentType: m[1], size, dataUrl: val })
      obj[key] = fileName
    }
  }
  visit(data)
  return media
}

router.post('/forms/:key/submissions', async (req, res) => {
  const { instance_id: instanceId, version, data } = req.body || {}
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9:_-]{8,80}$/.test(instanceId)) return res.status(400).json({ error: 'instance_id is required' })
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'data must be an object' })
  const pool = getPool()
  try {
    // Validate against the version the answers were collected with (it may have been filled offline before a republish).
    const { rows } = await pool.query(
      `SELECT f.id AS form_id, f.kind, v.id AS version_id, v.schema
         FROM forms f JOIN form_versions v ON v.form_id = f.id
        WHERE f.org_id = $1 AND f.form_key = $2
          AND v.version = COALESCE($3::int, (SELECT version FROM form_versions WHERE id = f.current_version_id))`,
      [req.user.orgId, req.params.key, Number.isInteger(version) ? version : null])
    const form = rows[0]
    if (!form || (form.kind === 'entity' && !ENTITY_WRITERS[req.params.key])) return res.status(404).json({ error: 'Form not found or not published' })
    const entity = form.kind === 'entity' ? req.params.key : null
    if (entity && !canWrite(req, entity)) return res.status(403).json({ error: 'You do not have permission to add these records' })
    const projects = entity === 'beneficiary' ? await orgProjects(req.user.orgId) : []
    const schema = entity ? withDynamicChoices(form.schema, { projects }) : form.schema

    const { data: clean, errors } = evaluateForm(schema, data)
    if (Object.keys(errors).length) return res.status(422).json({ error: 'Some answers are missing or invalid.', errors })
    const media = extractMedia(clean, buildTree(schema.survey).defs)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(req.user.orgId)])
      // Claim the instance_id first: a resend then can't create a second record.
      const { rows: ins } = await client.query(
        `INSERT INTO form_submissions (org_id, form_id, version_id, instance_id, data, source, submitted_by)
         VALUES ($1, $2, $3, $4, $5, 'web', $6)
         ON CONFLICT (org_id, instance_id) DO NOTHING RETURNING id`,
        [req.user.orgId, form.form_id, form.version_id, instanceId, JSON.stringify(entity ? splitAnswers(entity, clean).custom : clean), await userId(req)])
      if (!ins.length) {
        await client.query('ROLLBACK')
        const { rows: prev } = await pool.query(`SELECT entity_row_id FROM form_submissions WHERE org_id = $1 AND instance_id = $2`, [req.user.orgId, instanceId])
        return res.json({ ok: true, duplicate: true, uid: prev[0]?.entity_row_id ?? undefined })
      }
      let record = null
      if (entity) {
        record = await writeEntity(client, entity, req.user.orgId, clean, { projects })
        await client.query(`UPDATE form_submissions SET entity_row_id = $1 WHERE id = $2`, [String(record.uid), ins[0].id])
      }
      for (const m of media) {
        await client.query(
          `INSERT INTO form_media (org_id, submission_id, file_name, content_type, size_bytes, storage_path) VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.user.orgId, ins[0].id, m.fileName, m.contentType, m.size, m.dataUrl])
      }
      await client.query('COMMIT')
      res.status(201).json({ ok: true, id: ins[0].id, ...(record && { uid: record.uid, label: record.label }) })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      // 23505 = the registration tables' (org, phone hash, name) unique index — a race the dup-check can't close.
      if (e.code === '23505') throw new WriteError(409, 'This record appears to already be registered with these details.')
      throw e
    } finally { client.release() }
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message })
    fail(res, e)
  }
})

router.get('/forms/:key/submissions', async (req, res) => {
  try {
    const all = canSeeAll(req)
    const { rows } = await getPool().query(
      `SELECT s.id, s.data, s.source, s.created_at, v.version, u.name AS submitted_by,
              COALESCE((SELECT json_object_agg(m.file_name, m.id) FROM form_media m WHERE m.submission_id = s.id), '{}') AS media
         FROM form_submissions s
         JOIN forms f ON f.id = s.form_id
         JOIN form_versions v ON v.id = s.version_id
         LEFT JOIN users u ON u.id = s.submitted_by
        WHERE s.org_id = $1 AND f.form_key = $2 AND f.kind = 'custom'
          AND ($3 OR u.firebase_uid = $4)
        ORDER BY s.created_at DESC LIMIT 500`,
      [req.user.orgId, req.params.key, all, req.user.uid])
    res.json(rows)
  } catch (e) { fail(res, e) }
})

router.get('/forms/:key/media/:mediaId([0-9a-fA-F-]{36})', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT m.content_type, m.storage_path FROM form_media m
         JOIN form_submissions s ON s.id = m.submission_id
         LEFT JOIN users u ON u.id = s.submitted_by
        WHERE m.id = $1 AND m.org_id = $2 AND ($3 OR u.firebase_uid = $4)`,
      [req.params.mediaId, req.user.orgId, canSeeAll(req), req.user.uid])
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    const b64 = rows[0].storage_path.slice(rows[0].storage_path.indexOf(',') + 1)
    res.set('Content-Type', rows[0].content_type).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(b64, 'base64'))
  } catch (e) { fail(res, e) }
})

export default router
