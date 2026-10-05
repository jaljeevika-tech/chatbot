// Document Vault: per-project files in legal/financial/progress/knowledge tabs.
// Files arrive as base64 data URLs and are stored in storage_path (no object
// storage yet; swapping it in won't change the route contract).
// Text is extracted on upload so /api/notebook/chat can answer questions about the
// document; status is 'indexed' or 'unsupported' (still downloadable, no AI grounding).
// `?tab=reports` is a virtual cross-tab view of documents with a report_category.
//
//   GET    /api/projects/:projectKey/documents?tab=legal              — list by vault_tab (tab optional, defaults to all)
//   GET    /api/projects/:projectKey/documents?tab=reports&category=  — cross-tab view of documents with a report_category
//   POST   /api/projects/:projectKey/documents                        — upload { name, file_type, data (base64), vault_tab, report_category, tags }
//   GET    /api/projects/:projectKey/documents/:id/content            — raw file bytes (view/download)
//   GET    /api/projects/:projectKey/documents/:id/text                — extracted plain text (AI grounding)
//   DELETE /api/projects/:projectKey/documents/:id                    — delete

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor } from '../lib/routeGuards.js'
import { extractText } from '../lib/extractDocumentText.js'
import { suggestVaultCategory, suggestReportMetadata } from '../lib/nlp.js'
import { getOrgMeta } from '../lib/orgMetaCache.js'
import { isDangerousMime, isInlineSafeMime, safeServingContentType } from '../lib/fileSafety.js'

const router = Router()
const VAULT_TABS = ['legal', 'financial', 'progress', 'knowledge']

/** Splits a `data:<mime>;base64,<payload>` URL into { mimeType, buffer }. Throws on malformed input. */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;]*);base64,([\s\S]+)$/.exec(dataUrl)
  if (!match) throw new Error('data must be a base64 data URL')
  return { mimeType: match[1] || null, buffer: Buffer.from(match[2], 'base64') }
}

router.get('/projects/:projectKey/documents', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { tab, category } = req.query
    const params = [req.user.orgId, req.params.projectKey]
    let extraWhere = ''

    if (tab === 'reports') {
      extraWhere = 'AND report_category IS NOT NULL'
      if (category) {
        params.push(category)
        extraWhere += ` AND report_category = $${params.length}`
      }
    } else if (tab) {
      params.push(tab)
      extraWhere = `AND vault_tab = $${params.length}`
    }

    const { rows } = await pool.query(
      `SELECT id, vault_tab, name, file_type, status, created_at, uploaded_by, report_category, tags
       FROM project_documents
       WHERE org_id = $1 AND project_key = $2 ${extraWhere}
       ORDER BY created_at DESC`,
      params
    )
    res.json({ documents: rows })
  } catch (e) {
    console.error('[documents GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/projects/:projectKey/documents', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { name, file_type, data, vault_tab, report_category, tags } = req.body || {}
    if (!name || !data) return res.status(400).json({ error: 'name and data (base64) are required' })
    const tab = VAULT_TABS.includes(vault_tab) ? vault_tab : 'legal'
    const cleanTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase()).slice(0, 12) : []
    const pool = getPool()

    // Extract before inserting so the row is written once with its final status.
    let extractedText = null
    try {
      const decoded = decodeDataUrl(data)
      // Check the actual data: URL prefix (what gets re-served) as well as the
      // declared file_type, since they can disagree. See lib/fileSafety.js.
      if (isDangerousMime(decoded.mimeType) || isDangerousMime(file_type)) {
        return res.status(400).json({ error: `Unsupported file type "${decoded.mimeType || file_type}" — HTML/SVG/script content cannot be uploaded` })
      }
      extractedText = await extractText(decoded.buffer, file_type, name)
    } catch (e) {
      console.warn('[documents POST] extraction skipped:', e.message)
    }
    const status = extractedText ? 'indexed' : 'unsupported'

    const { rows } = await pool.query(
      `INSERT INTO project_documents (org_id, project_key, vault_tab, name, file_type, storage_path, uploaded_by, status, extracted_text, report_category, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, vault_tab, name, file_type, status, created_at, uploaded_by, report_category, tags`,
      [req.user.orgId, req.params.projectKey, tab, name, file_type || null, data, req.user.name || 'unknown', status, extractedText, report_category || null, cleanTags]
    )
    res.json(rows[0])
  } catch (e) {
    console.error('[documents POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Suggests vault tab, report category and tags for a not-yet-uploaded file from one
// text-extraction pass. Writes nothing.
router.post('/projects/:projectKey/documents/suggest-category', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { name, file_type, data } = req.body || {}
    if (!name || !data) return res.status(400).json({ error: 'name and data (base64) are required' })
    let extractedText = null
    try {
      const { buffer } = decodeDataUrl(data)
      extractedText = await extractText(buffer, file_type, name)
    } catch (e) {
      console.warn('[documents suggest-category] extraction skipped:', e.message)
    }
    const orgCategories = (await getOrgMeta(req.user.orgId))?.reportCategories
    const [vaultSuggestion, reportSuggestion] = await Promise.all([
      suggestVaultCategory(name, extractedText),
      suggestReportMetadata(name, extractedText, orgCategories),
    ])
    res.json({
      ...vaultSuggestion,
      reportCategory: reportSuggestion.reportCategory,
      tags: reportSuggestion.tags,
    })
  } catch (e) {
    console.error('[documents suggest-category]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/projects/:projectKey/documents/:id([0-9a-fA-F-]{36})/content', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT name, file_type, storage_path FROM project_documents
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
    console.error('[documents content GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/projects/:projectKey/documents/:id([0-9a-fA-F-]{36})/text', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT status, extracted_text FROM project_documents
       WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    if (rows[0].status !== 'indexed' || !rows[0].extracted_text) {
      return res.status(404).json({ error: 'No extracted text available for this document' })
    }
    res.json({ extracted_text: rows[0].extracted_text })
  } catch (e) {
    console.error('[documents text GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.delete('/projects/:projectKey/documents/:id([0-9a-fA-F-]{36})', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { rowCount } = await pool.query(
      `DELETE FROM project_documents WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) {
    console.error('[documents DELETE]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
