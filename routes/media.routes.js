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
//
// Plus the field-report photos (Sheet + daily_reports attachments) the Media tab pages through:
//   GET    /api/media?limit=&offset=&search=&project=&state=&area=&workerName=&dateFrom=&dateTo=

import { Router } from 'express'
import Papa from 'papaparse'
import { getPool } from '../db/pool.js'
import { requireAuth, requireEditor } from '../lib/routeGuards.js'
import { suggestMediaCategory } from '../lib/nlp.js'
import { getOrgMeta } from '../lib/orgMetaCache.js'
import { isDangerousMime, isInlineSafeMime, safeServingContentType } from '../lib/fileSafety.js'
import { normPhone } from '../lib/sheets.js'
import { cleanReports, mergeProjectAlias, sheetRowToReport } from '../lib/cleanReport.js'

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

// ── Field-report photos ───────────────────────────────────────────────────────
// The same rows the dashboard builds client-side (ReportContext.tsx + DashboardPage
// baseReports/filteredReports), photos only, so the Media tab can page through them.

const REPORT_MEDIA_TTL = 30_000
// orgId -> { ts, promise } — the promise is shared so concurrent requests load once.
const _reportMediaCache = new Map()

const norm = v => String(v ?? '').trim().toLowerCase()

async function fetchCsvRows(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`sheet fetch failed (${res.status})`)
  return Papa.parse(await res.text(), { header: true, skipEmptyLines: true }).data
}

async function loadSheetReports(sheetId) {
  if (!sheetId) return []
  const rows = await fetchCsvRows(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv`)
  return cleanReports(rows.map(sheetRowToReport))
}

// GET /reports/daily's rows with ReportContext's fixes applied, photo rows only.
async function loadDbReports(orgId) {
  const { rows } = await getPool().query(
    `SELECT dr.id, dr.report_date, dr.state, dr.location, dr.project, dr.area_of_intervention,
            dr.description, dr.attachment_url, dr.custom_data,
            u.name AS submitter_name, u.phone AS submitter_phone
     FROM daily_reports dr
     LEFT JOIN users u ON u.id = dr.submitted_by
     WHERE dr.org_id = $1 AND dr.attachment_url ~* '^https?://'
     ORDER BY dr.report_date DESC, dr.created_at DESC
     LIMIT 1000`,
    [orgId]
  )
  return rows.map(r => ({
    id:                 'db-' + r.id,
    // What the JSON round trip through /reports/daily used to produce
    timestamp:          r.report_date instanceof Date ? r.report_date.toISOString() : String(r.report_date || ''),
    name:               r.submitter_name || r.custom_data?.wa_name || '',
    phone:              r.submitter_phone || r.custom_data?.wa_phone || '',
    state:              r.state || '',
    location:           r.location || '',
    project:            mergeProjectAlias(r.project || '', r.state || '', r.location || ''),
    areaOfIntervention: r.area_of_intervention || '',
    description:        r.description || '',
    attachmentUrl:      r.attachment_url,
    source:             r.custom_data?.source === 'whatsapp-flow' ? 'whatsapp' : 'web',
  }))
}

// Manager → team mapping lives in the users sheet (columns Name / Phone / Manager).
async function loadSheetUsers(sheetId) {
  if (!sheetId) return []
  return fetchCsvRows(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=Sheet1`)
}

async function loadOrgReportMedia(orgId) {
  const ds = (await getOrgMeta(orgId)).data_sources || {}
  const results = await Promise.allSettled([
    loadSheetReports(ds.reports_sheet_id),
    loadDbReports(orgId),
    loadSheetUsers(ds.users_sheet_id),
  ])
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[media/reports] source failed:', r.reason?.message)
  }
  const [sheet, db, users] = results.map(r => r.status === 'fulfilled' ? r.value : [])
  const media = [...db, ...sheet]
    .filter(r => r.attachmentUrl)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
  return { media, users, complete: results.every(r => r.status === 'fulfilled') }
}

function getOrgReportMedia(orgId) {
  const hit = _reportMediaCache.get(orgId)
  if (hit && Date.now() - hit.ts < REPORT_MEDIA_TTL) return hit.promise
  const entry = { ts: Date.now(), promise: loadOrgReportMedia(orgId) }
  _reportMediaCache.set(orgId, entry)
  // A load that missed a source is served once, not cached, so the next request retries.
  const evict = () => { if (_reportMediaCache.get(orgId) === entry) _reportMediaCache.delete(orgId) }
  entry.promise.then(r => { if (!r.complete) evict() }, evict)
  return entry.promise
}

// Same rule as DashboardPage's baseReports. Empty names/phones never match, since
// this is the server-side boundary (the client's version was only a view filter).
async function scopeToCaller(media, users, user) {
  if (user.role === 'admin' || user.role === 'superadmin') return media
  const { rows } = await getPool().query(
    `SELECT name, phone FROM users WHERE firebase_uid = $1 AND org_id = $2 LIMIT 1`,
    [user.uid, user.orgId]
  )
  const myName  = norm(user.name || rows[0]?.name)
  const myPhone = normPhone(rows[0]?.phone || user.phone)
  let phones
  if (user.role === 'manager') {
    phones = new Set(users
      .filter(u => {
        const manager = norm(u.Manager)
        return (myName && (manager === myName || norm(u.Name) === myName))
            || (myPhone && normPhone(manager) === myPhone)
      })
      .map(u => normPhone(u.Phone)))
  } else {
    phones = new Set([myPhone])
  }
  phones.delete('')
  return media.filter(r => phones.has(normPhone(r.phone)))
}

router.get('/media', async (req, res) => {
  if (!requireAuth(req, res)) return
  try {
    // URLSearchParams rather than req.query: qs turns 20+ repeated keys into an object.
    const q = new URL(req.originalUrl, 'http://localhost').searchParams
    const list = key => q.getAll(key).map(norm).filter(Boolean)
    const projects = list('project'), states = list('state'), areas = list('area'), workers = list('workerName')
    const dateFrom = q.get('dateFrom') || ''
    const dateTo   = q.get('dateTo')   || ''
    const search   = norm(q.get('search'))
    const limit    = Math.min(parseInt(q.get('limit'),  10) || 48, 200)
    const offset   = Math.max(parseInt(q.get('offset'), 10) || 0,  0)

    const { media, users } = await getOrgReportMedia(req.user.orgId)
    const inList = (values, v) => !values.length || values.includes(norm(v))
    const items = (await scopeToCaller(media, users, req.user)).filter(r => {
      if (!inList(projects, r.project) || !inList(states, r.state)
       || !inList(areas, r.areaOfIntervention) || !inList(workers, r.name)) return false
      if (dateFrom || dateTo) {
        const date = String(r.timestamp).slice(0, 10)
        if (!date || (dateFrom && date < dateFrom) || (dateTo && date > dateTo)) return false
      }
      return !search || [r.project, r.location, r.name, r.areaOfIntervention, r.description, r.source]
        .some(field => norm(field).includes(search))
    })

    // Phone stays server-side: it's only needed for the role scoping above.
    res.json({
      items: items.slice(offset, offset + limit).map(r => ({
        id: r.id, timestamp: r.timestamp, name: r.name, state: r.state, location: r.location,
        project: r.project, areaOfIntervention: r.areaOfIntervention, description: r.description,
        attachmentUrl: r.attachmentUrl, source: r.source,
      })),
      total: items.length,
    })
  } catch (e) {
    console.error('[media/reports GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
