// Media Library uploads: per-project video/audio/picture/PDF files, stored like
// Document Vault (base64 data URL in storage_path). 25MB raw cap — bigger blobs
// bloat Postgres rows. `category` is a topic label sharing the org's report
// categories (metadata.reportCategories), separate from the technical media_type.
//
//   GET    /api/projects/:projectKey/media?type=video&category=  — list (both filters optional)
//   POST   /api/projects/:projectKey/media                        — upload { name, file_type, data (base64), category }
//   POST   /api/projects/:projectKey/media/suggest-category        — AI category suggestion for a not-yet-uploaded file
//   GET    /api/projects/:projectKey/media/:id/content             — raw file bytes (view/download)
//   DELETE /api/projects/:projectKey/media/:id                     — delete

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { suggestMediaCategory } from '../lib/nlp.js'
import { getOrgMeta } from '../lib/orgMetaCache.js'
import { isDangerousMime, isInlineSafeMime, safeServingContentType } from '../lib/fileSafety.js'

const router = Router()
const MEDIA_TYPES = ['image', 'video', 'audio', 'pdf', 'other']
const MAX_BYTES = 25 * 1024 * 1024 // 25MB raw file size, decoded

/** Splits a `data:<mime>;base64,<payload>` URL into { mimeType, buffer }. Throws on malformed input. */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]*);base64,([\s\S]+)$/.exec(dataUrl)
  if (!match) throw new Error('data must be a base64 data URL')
  return { mimeType: match[1] || null, buffer: Buffer.from(match[2], 'base64') }
}

/** Buckets a MIME type into one of MEDIA_TYPES for filtering/icons. */
function classifyMediaType(mimeType, name) {
  const mt = (mimeType || '').toLowerCase()
  if (mt.startsWith('image/')) return 'image'
  if (mt.startsWith('video/')) return 'video'
  if (mt.startsWith('audio/')) return 'audio'
  if (mt === 'application/pdf') return 'pdf'
  const ext = (name || '').toLowerCase().split('.').pop()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  return 'other'
}

router.get('/projects/:projectKey/media', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { type, category } = req.query
    const params = [req.user.orgId, req.params.projectKey]
    let extraWhere = ''
    if (type && MEDIA_TYPES.includes(type)) {
      params.push(type)
      extraWhere += ` AND media_type = $${params.length}`
    }
    if (category) {
      params.push(category)
      extraWhere += ` AND category = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT id, media_type, name, file_type, size_bytes, uploaded_by, created_at, category
       FROM project_media
       WHERE org_id = $1 AND project_key = $2 ${extraWhere}
       ORDER BY created_at DESC`,
      params
    )
    res.json({ media: rows })
  } catch (e) {
    console.error('[media GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Suggests a category for a not-yet-uploaded file from its filename and, for
// small image/video/audio/pdf, its bytes. Writes nothing.
router.post('/projects/:projectKey/media/suggest-category', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { name, file_type, data } = req.body || {}
    if (!name || !data) return res.status(400).json({ error: 'name and data (base64) are required' })
    let buffer = null
    let mimeType = file_type
    try {
      const decoded = decodeDataUrl(data)
      buffer = decoded.buffer
      mimeType = file_type || decoded.mimeType
    } catch (e) {
      console.warn('[media suggest-category] decode failed:', e.message)
    }
    const orgCategories = (await getOrgMeta(req.user.orgId))?.reportCategories
    const suggestion = await suggestMediaCategory(name, mimeType, buffer, orgCategories)
    res.json(suggestion)
  } catch (e) {
    console.error('[media suggest-category]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/projects/:projectKey/media', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { name, file_type, data, category } = req.body || {}
    if (!name || !data) return res.status(400).json({ error: 'name and data (base64) are required' })

    const { mimeType, buffer } = decodeDataUrl(data)
    // Check the actual data: URL prefix (what gets re-served) as well as the
    // declared file_type, since they can disagree. See lib/fileSafety.js.
    if (isDangerousMime(mimeType) || isDangerousMime(file_type)) {
      return res.status(400).json({ error: `Unsupported file type "${mimeType || file_type}" — HTML/SVG/script content cannot be uploaded` })
    }
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: `File too large — max ${Math.floor(MAX_BYTES / (1024 * 1024))}MB` })
    }
    const effectiveMime = file_type || mimeType
    const mediaType = classifyMediaType(effectiveMime, name)

    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO project_media (org_id, project_key, media_type, name, file_type, size_bytes, storage_path, uploaded_by, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, media_type, name, file_type, size_bytes, uploaded_by, created_at, category`,
      [req.user.orgId, req.params.projectKey, mediaType, name, effectiveMime || null, buffer.length, data, req.user.name || 'unknown', category || null]
    )
    res.json(rows[0])
  } catch (e) {
    console.error('[media POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/projects/:projectKey/media/:id([0-9a-fA-F-]{36})/content', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT name, file_type, storage_path FROM project_media
       WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    const { name, file_type, storage_path } = rows[0]
    const { mimeType, buffer } = decodeDataUrl(storage_path)
    const effectiveMime = mimeType || file_type
    // Never trust the stored MIME for inline rendering: anything outside the safe
    // image/audio/video/pdf set downloads, including older rows. See lib/fileSafety.js.
    const disposition = isInlineSafeMime(effectiveMime) ? 'inline' : 'attachment'
    res.setHeader('Content-Type', safeServingContentType(effectiveMime))
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(name)}"`)
    res.send(buffer)
  } catch (e) {
    console.error('[media content GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/projects/:projectKey/media/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM project_media WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[media DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
