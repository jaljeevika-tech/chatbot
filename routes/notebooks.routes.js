// Saved "Ask AI" notebooks (073): Postgres persistence only — the Gemini calls live
// in notebook.routes.js. Notebooks are personal (org_id + created_by_uid).
//
//   GET    /api/notebooks                       — list caller's notebooks
//   POST   /api/notebooks                       — create
//   PATCH  /api/notebooks/:id                    — rename
//   DELETE /api/notebooks/:id
//   GET    /api/notebooks/:id                    — full sources + messages + outputs
//   POST   /api/notebooks/:id/sources
//   DELETE /api/notebooks/:id/sources/:sourceId
//   POST   /api/notebooks/:id/messages
//   PUT    /api/notebooks/:id/outputs/:kind       — save a generated output (db/migrations/074_notebook_outputs.sql)

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireAuth } from '../lib/routeGuards.js'

const router = Router()

// Fixed set of persistable output tabs, so clients can't create arbitrary kinds.
const OUTPUT_KINDS = new Set(['study_guide', 'slide_deck', 'mind_map', 'video_overview', 'flashcards_quiz', 'audio_overview'])

/** Confirms the notebook exists and belongs to the caller. Returns the row or null. */
async function loadOwnedNotebook(pool, id, req) {
  const { rows } = await pool.query(
    `SELECT * FROM notebooks WHERE id = $1 AND org_id = $2 AND created_by_uid = $3`,
    [id, req.user.orgId, req.user.uid]
  )
  return rows[0] || null
}

// GET /api/notebooks
router.get('/notebooks', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT n.id, n.name, n.created_at, n.updated_at,
              (SELECT count(*) FROM notebook_sources  s WHERE s.notebook_id = n.id)::int AS source_count,
              (SELECT count(*) FROM notebook_messages m WHERE m.notebook_id = n.id)::int AS message_count
       FROM notebooks n
       WHERE n.org_id = $1 AND n.created_by_uid = $2
       ORDER BY n.updated_at DESC`,
      [req.user.orgId, req.user.uid]
    )
    res.json({ notebooks: rows })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to list notebooks' })
  }
})

// POST /api/notebooks  { name? }
router.post('/notebooks', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const name = String(req.body?.name || 'Untitled notebook').slice(0, 200)
    const { rows } = await pool.query(
      `INSERT INTO notebooks (org_id, created_by_uid, created_by_name, name)
       VALUES ($1, $2, $3, $4) RETURNING id, name, created_at, updated_at`,
      [req.user.orgId, req.user.uid, req.user.name || null, name]
    )
    res.json({ notebook: { ...rows[0], source_count: 0, message_count: 0 } })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to create notebook' })
  }
})

// PATCH /api/notebooks/:id  { name }
router.patch('/notebooks/:id', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    const name = String(req.body?.name || existing.name).slice(0, 200)
    const { rows } = await pool.query(
      `UPDATE notebooks SET name = $1, updated_at = now() WHERE id = $2 RETURNING id, name, created_at, updated_at`,
      [name, existing.id]
    )
    res.json({ notebook: rows[0] })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to rename notebook' })
  }
})

// DELETE /api/notebooks/:id
router.delete('/notebooks/:id', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    await pool.query(`DELETE FROM notebooks WHERE id = $1`, [existing.id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to delete notebook' })
  }
})

// image_urls (JSONB) holds either a plain URL list or [{ url, caption?, date?, place? }]
// so Video Overview can place and label the right field photo; both shapes read back
// as imageUrls + imageCaptions + imageMeta.
function packImages(imageUrls, imageCaptions, imageMeta) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return null
  const caps = imageCaptions && typeof imageCaptions === 'object' ? imageCaptions : {}
  const meta = imageMeta && typeof imageMeta === 'object' ? imageMeta : {}
  return imageUrls.filter(u => typeof u === 'string').map(url => {
    const m = meta[url] || {}
    const o = { url }
    if (caps[url]) o.caption = String(caps[url]).slice(0, 300)
    if (m.date) o.date = String(m.date).slice(0, 40)
    if (m.place) o.place = String(m.place).slice(0, 120)
    return o
  })
}
function unpackImages(stored) {
  if (!Array.isArray(stored) || stored.length === 0) return {}
  const imageUrls = [], imageCaptions = {}, imageMeta = {}
  for (const it of stored) {
    const url = typeof it === 'string' ? it : it?.url
    if (!url) continue
    imageUrls.push(url)
    if (it && typeof it === 'object') {
      if (it.caption) imageCaptions[url] = it.caption
      if (it.date || it.place) imageMeta[url] = { ...(it.date ? { date: it.date } : {}), ...(it.place ? { place: it.place } : {}) }
    }
  }
  return {
    imageUrls,
    ...(Object.keys(imageCaptions).length ? { imageCaptions } : {}),
    ...(Object.keys(imageMeta).length ? { imageMeta } : {}),
  }
}

// GET /api/notebooks/:id — sources + messages + generated outputs
router.get('/notebooks/:id', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    const [{ rows: sources }, { rows: messages }, { rows: outputRows }] = await Promise.all([
      pool.query(
        `SELECT id, name, type, content, char_count, image_urls, added_at
         FROM notebook_sources WHERE notebook_id = $1 ORDER BY added_at ASC`,
        [existing.id]
      ),
      pool.query(
        `SELECT id, role, text, created_at FROM notebook_messages WHERE notebook_id = $1 ORDER BY created_at ASC`,
        [existing.id]
      ),
      pool.query(
        `SELECT kind, data, updated_at FROM notebook_outputs WHERE notebook_id = $1`,
        [existing.id]
      ),
    ])
    const outputs = {}
    for (const o of outputRows) outputs[o.kind] = { data: o.data, updatedAt: o.updated_at }
    res.json({
      notebook: { id: existing.id, name: existing.name, created_at: existing.created_at, updated_at: existing.updated_at },
      sources: sources.map(s => ({
        id: s.id, name: s.name, type: s.type, content: s.content, charCount: s.char_count,
        addedAt: s.added_at, ...unpackImages(s.image_urls),
      })),
      messages: messages.map(m => ({ id: m.id, role: m.role, text: m.text, timestamp: m.created_at })),
      outputs,
    })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load notebook' })
  }
})

// POST /api/notebooks/:id/sources  { name, type, content, charCount, imageUrls?, imageCaptions?, imageMeta? }
router.post('/notebooks/:id/sources', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    const body = req.body || {}
    const { type, charCount, imageUrls, imageCaptions, imageMeta } = body
    // PostgreSQL TEXT can't hold NUL characters
    const name = typeof body.name === 'string' ? body.name.replace(/\u0000/g, '') : body.name
    const content = typeof body.content === 'string' ? body.content.replace(/\u0000/g, '') : body.content
    const images = packImages(imageUrls, imageCaptions, imageMeta)
    if (!name || !content) { res.status(400).json({ error: 'name and content are required' }); return }
    const { rows } = await pool.query(
      `INSERT INTO notebook_sources (notebook_id, name, type, content, char_count, image_urls)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, added_at`,
      [existing.id, name, type || 'txt', content, charCount || content.length, images ? JSON.stringify(images) : null]
    )
    await pool.query(`UPDATE notebooks SET updated_at = now() WHERE id = $1`, [existing.id])
    res.json({ id: rows[0].id, addedAt: rows[0].added_at })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to add source' })
  }
})

// DELETE /api/notebooks/:id/sources/:sourceId
router.delete('/notebooks/:id/sources/:sourceId', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    await pool.query(`DELETE FROM notebook_sources WHERE id = $1 AND notebook_id = $2`, [req.params.sourceId, existing.id])
    await pool.query(`UPDATE notebooks SET updated_at = now() WHERE id = $1`, [existing.id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to remove source' })
  }
})

// POST /api/notebooks/:id/messages  { role, text }
router.post('/notebooks/:id/messages', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    const { role, text } = req.body || {}
    if (!role || typeof text !== 'string') { res.status(400).json({ error: 'role and text are required' }); return }
    const { rows } = await pool.query(
      `INSERT INTO notebook_messages (notebook_id, role, text) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [existing.id, role, text]
    )
    await pool.query(`UPDATE notebooks SET updated_at = now() WHERE id = $1`, [existing.id])
    res.json({ id: rows[0].id, timestamp: rows[0].created_at })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to save message' })
  }
})

// PUT /api/notebooks/:id/outputs/:kind  { data }
// One JSONB blob per output tab, since each tab owns its own shape.
router.put('/notebooks/:id/outputs/:kind', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    if (!OUTPUT_KINDS.has(req.params.kind)) { res.status(400).json({ error: 'Unknown output kind' }); return }
    const pool = getPool()
    const existing = await loadOwnedNotebook(pool, req.params.id, req)
    if (!existing) { res.status(404).json({ error: 'Notebook not found' }); return }
    const { data } = req.body || {}
    if (data === undefined) { res.status(400).json({ error: 'data is required' }); return }
    const { rows } = await pool.query(
      `INSERT INTO notebook_outputs (notebook_id, kind, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (notebook_id, kind) DO UPDATE SET data = $3, updated_at = now()
       RETURNING updated_at`,
      [existing.id, req.params.kind, JSON.stringify(data)]
    )
    await pool.query(`UPDATE notebooks SET updated_at = now() WHERE id = $1`, [existing.id])
    res.json({ ok: true, updatedAt: rows[0].updated_at })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to save output' })
  }
})

export default router
