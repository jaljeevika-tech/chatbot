// MIS data sources: per-project import hub for Excel/CSV/Google Sheets (schema in
// 028_mis_indicators_and_data_sources.sql, import types in lib/misImportSchemas.js).
// Files are parsed client-side; this route only receives mapped JSON rows.
//
//   GET    /api/projects/:projectKey/data-sources                — list
//   POST   /api/projects/:projectKey/data-sources                — create draft
//   PUT    /api/projects/:projectKey/data-sources/:id             — update mapping/sheet/status/url
//   POST   /api/projects/:projectKey/data-sources/:id/validate    — validate mapped rows, return counts
//   GET    /api/projects/:projectKey/data-sources/:id/errors      — download error rows as CSV
//   POST   /api/projects/:projectKey/data-sources/:id/import      — confirm import (writes real rows)
//   POST   /api/projects/:projectKey/data-sources/:id/sync        — Google Sheets manual sync (stubbed)
//   POST   /api/projects/:projectKey/data-sources/:id/archive
//   DELETE /api/projects/:projectKey/data-sources/:id              — admin only
//
//   GET    /api/mis-templates                    — list the 8 template types
//   GET    /api/mis-templates/:key/schema         — column definitions for the mapping UI
//   GET    /api/mis-templates/:key/xlsx           — downloadable template workbook

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { IMPORT_TYPES, getImportType, validateRow, identityKeyFor, buildTemplateWorkbook } from '../lib/misImportSchemas.js'

const router = Router()

const SOURCE_TYPES = ['excel', 'csv', 'google_sheet']
const IMPORT_TYPE_KEYS = IMPORT_TYPES.map(t => t.key)

function logAudit(pool, { orgId, actorUid, actorName, action, targetId, diff }) {
  pool.query(
    `INSERT INTO audit_log (org_id, actor_uid, actor_name, action, target_type, target_id, diff)
     VALUES ($1,$2,$3,$4,'data_sources',$5,$6)`,
    [orgId, actorUid, actorName, action, targetId, JSON.stringify(diff || {})]
  ).catch(() => {})
}

async function loadDataSource(pool, id, orgId, projectKey) {
  const { rows } = await pool.query(
    `SELECT * FROM data_sources WHERE id = $1 AND org_id = $2 AND project_key = $3`,
    [id, orgId, projectKey]
  )
  return rows[0] || null
}

// Loose Sheets/Drive URL check: real validity needs OAuth, which isn't built, so
// this only stops the UI calling a garbage paste "Ready".
function isPlausibleGoogleUrl(url) {
  return /^https:\/\/(docs|drive)\.google\.com\//.test(String(url || '').trim())
}

// Mapped rows leave blank numbers as '', which Postgres rejects for NUMERIC.
function numOrNull(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function extractGoogleSheetId(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

router.get('/projects/:projectKey/data-sources', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM data_sources WHERE org_id = $1 AND project_key = $2 ORDER BY updated_at DESC`,
      [req.user.orgId, req.params.projectKey]
    )
    res.json({ dataSources: rows })
  } catch (e) {
    console.error('[data-sources GET]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/projects/:projectKey/data-sources
// Body: { name, source_type, import_type, original_filename?, file_size_bytes?,
//         sheet_name?, google_sheet_url? }
router.post('/projects/:projectKey/data-sources', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const b = req.body || {}
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (!SOURCE_TYPES.includes(b.source_type)) return res.status(400).json({ error: `source_type must be one of ${SOURCE_TYPES.join(', ')}` })
    if (!IMPORT_TYPE_KEYS.includes(b.import_type)) return res.status(400).json({ error: `import_type must be one of ${IMPORT_TYPE_KEYS.join(', ')}` })

    let status = 'draft'
    let googleSheetUrl = null
    let googleSheetId = null

    if (b.source_type === 'google_sheet') {
      googleSheetUrl = String(b.google_sheet_url || '').trim()
      if (!isPlausibleGoogleUrl(googleSheetUrl)) {
        return res.status(400).json({ error: 'That does not look like a valid Google Sheets/Drive URL' })
      }
      googleSheetId = extractGoogleSheetId(googleSheetUrl)
      // Never "Ready" just because a link was pasted: live sync needs OAuth.
      status = 'sync_failed'
    } else if (b.original_filename) {
      status = 'uploaded'
    }

    const { rows: [dataSource] } = await getPool().query(
      `INSERT INTO data_sources
         (org_id, project_key, name, source_type, import_type, status,
          original_filename, file_size_bytes, sheet_name, google_sheet_url, google_sheet_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.user.orgId, req.params.projectKey, name, b.source_type, b.import_type, status,
        b.original_filename || null, b.file_size_bytes ?? null, b.sheet_name || null,
        googleSheetUrl, googleSheetId, req.user.name || 'unknown',
      ]
    )
    logAudit(getPool(), { orgId: req.user.orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'data_source.create', targetId: dataSource.id, diff: { name, source_type: b.source_type, import_type: b.import_type } })
    res.status(201).json({ ok: true, dataSource })
  } catch (e) {
    console.error('[data-sources POST]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/projects/:projectKey/data-sources/:id
// Body: any of { name, sheet_name, mapping_config, status, google_sheet_url }
router.put('/projects/:projectKey/data-sources/:id', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const existing = await loadDataSource(pool, req.params.id, req.user.orgId, req.params.projectKey)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const b = req.body || {}
    const { rows: [dataSource] } = await pool.query(
      `UPDATE data_sources SET
         name = COALESCE($1, name),
         sheet_name = COALESCE($2, sheet_name),
         mapping_config = COALESCE($3, mapping_config),
         status = COALESCE($4, status),
         google_sheet_url = COALESCE($5, google_sheet_url),
         updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [
        b.name?.trim() || null, b.sheet_name || null,
        b.mapping_config ? JSON.stringify(b.mapping_config) : null,
        b.status || null, b.google_sheet_url || null, req.params.id,
      ]
    )
    res.json({ ok: true, dataSource })
  } catch (e) {
    console.error('[data-sources PUT]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/projects/:projectKey/data-sources/:id/validate
// Body: { rows: [{...mappedFields}] }
// Dry run: stores counts/error samples on the data_source row, writes nothing else.
// Missing/ambiguous fields are always reported, never silently defaulted.
router.post('/projects/:projectKey/data-sources/:id/validate', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const dataSource = await loadDataSource(pool, req.params.id, req.user.orgId, req.params.projectKey)
    if (!dataSource) return res.status(404).json({ error: 'Not found' })

    const { rows } = req.body || {}
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const importType = dataSource.import_type
    const seenKeys = new Map() // identityKey -> first row index
    let existingCodes = new Set()
    if (importType === 'indicator_framework') {
      const { rows: existing } = await pool.query(
        `SELECT code FROM indicators WHERE org_id = $1 AND project_key = $2`,
        [req.user.orgId, req.params.projectKey]
      )
      existingCodes = new Set(existing.map(r => r.code.toLowerCase()))
    }

    let validCount = 0, invalidCount = 0, duplicateCount = 0, warningCount = 0
    const errorRows = []

    rows.forEach((row, i) => {
      const { errors, warnings } = validateRow(importType, row)
      const key = identityKeyFor(importType, row)

      // Exact full-row duplicate within this file: a warning, not a blocker —
      // any differing column changes the key (identityKeyFor in misImportSchemas.js).
      if (key && seenKeys.has(key)) {
        duplicateCount++
        warnings.push(`Duplicate of row ${seenKeys.get(key) + 1} in this file — every column matches exactly`)
      } else if (key) {
        seenKeys.set(key, i)
      }
      // Indicator codes are unique per project against already-imported data: blocking.
      if (importType === 'indicator_framework' && row.code && existingCodes.has(String(row.code).trim().toLowerCase())) {
        errors.push(`Code "${row.code}" already exists in this project`)
      }

      if (errors.length) {
        invalidCount++
        errorRows.push({ row: i + 1, data: row, errors, warnings })
      } else {
        validCount++
        if (warnings.length) { warningCount++; errorRows.push({ row: i + 1, data: row, errors: [], warnings }) }
      }
    })

    const rowCounts = { valid: validCount, invalid: invalidCount, duplicate: duplicateCount, warning: warningCount }
    const newStatus = invalidCount > 0 ? 'validation_failed' : 'ready_to_import'

    const { rows: [updated] } = await pool.query(
      `UPDATE data_sources SET row_counts = $1, error_rows = $2, status = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [JSON.stringify(rowCounts), JSON.stringify(errorRows.slice(0, 500)), newStatus, req.params.id]
    )
    res.json({ ok: true, dataSource: updated, rowCounts })
  } catch (e) {
    console.error('[data-sources validate]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/projects/:projectKey/data-sources/:id/errors — CSV of error_rows
router.get('/projects/:projectKey/data-sources/:id/errors', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const dataSource = await loadDataSource(pool, req.params.id, req.user.orgId, req.params.projectKey)
    if (!dataSource) return res.status(404).json({ error: 'Not found' })

    const errorRows = dataSource.error_rows || []
    const csvEscape = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = ['Row,Errors,Warnings,Data']
    for (const er of errorRows) {
      lines.push([
        er.row,
        csvEscape((er.errors || []).join('; ')),
        csvEscape((er.warnings || []).join('; ')),
        csvEscape(JSON.stringify(er.data || {})),
      ].join(','))
    }
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${dataSource.name.replace(/[^a-z0-9_-]+/gi, '_')}-errors.csv"`)
    res.send(lines.join('\n'))
  } catch (e) {
    console.error('[data-sources errors]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/projects/:projectKey/data-sources/:id/import
// Body: { rows } as sent to /validate. Re-validates (never trusts a stale client
// "ready" state) and writes only valid rows.
router.post('/projects/:projectKey/data-sources/:id/import', async (req, res) => {
  if (!requireEditor(req, res)) return
  const pool = getPool()
  const orgId = req.user.orgId
  const projectKey = req.params.projectKey
  const client = await pool.connect()
  try {
    const dataSource = await loadDataSource(pool, req.params.id, orgId, projectKey)
    if (!dataSource) return res.status(404).json({ error: 'Not found' })

    const { rows } = req.body || {}
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows[] required' })

    const importType = dataSource.import_type
    let validCount = 0, invalidCount = 0

    await client.query('BEGIN')
    await client.query(`UPDATE data_sources SET status = 'importing', updated_at = NOW() WHERE id = $1`, [req.params.id])

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const { errors } = validateRow(importType, row)
      if (errors.length) { invalidCount++; continue }

      if (importType === 'indicator_framework') {
        // ON CONFLICT, not catching 23505: a unique violation would abort the transaction.
        const { rowCount } = await client.query(
          `INSERT INTO indicators
             (org_id, project_key, code, name, level, unit, frequency, aggregation_method,
              data_source, responsible_person, baseline_value, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT DO NOTHING`,
          [
            orgId, projectKey, String(row.code).trim(), String(row.name).trim(), row.level,
            row.unit || null, row.frequency || 'monthly', row.aggregation_method || 'sum',
            row.data_source || null, row.responsible_person || null, numOrNull(row.baseline_value),
            req.user.name || 'unknown',
          ]
        )
        if (rowCount) validCount++
        else invalidCount++
      } else if (importType === 'monthly_plan_actual') {
        // Writes indicator_monthly_entries, the same table as mis-entries.routes.js,
        // so it shows in the Monthly Plan & Actual grid and MIS Dashboard immediately.
        const code = String(row.indicator_code || '').trim()
        const { rows: [indicator] } = await client.query(
          `SELECT id FROM indicators WHERE org_id = $1 AND project_key = $2 AND lower(code) = lower($3)`,
          [orgId, projectKey, code]
        )
        if (!indicator) { invalidCount++; continue }

        const fyStartYear = Number(row.financial_year)
        const month = row.month
        const geography = String(row.geography || '').trim()
        const scope = geography ? 'geography' : 'project'
        const scopeValue = geography || null

        const { rows: [existing] } = await client.query(
          `SELECT id, status FROM indicator_monthly_entries
           WHERE indicator_id = $1 AND fy_start_year = $2 AND month = $3 AND scope = $4 AND COALESCE(scope_value,'') = COALESCE($5,'')
             AND org_id = $6`,
          [indicator.id, fyStartYear, month, scope, scopeValue, orgId]
        )
        // Same guard as mis-entries' autosave: never overwrite past 'draft'.
        if (existing && existing.status !== 'draft') { invalidCount++; continue }

        if (existing) {
          await client.query(
            `UPDATE indicator_monthly_entries SET plan = $1, actual = $2, remarks = $3, updated_at = NOW() WHERE id = $4`,
            [numOrNull(row.plan), numOrNull(row.actual), row.remarks || null, existing.id]
          )
        } else {
          await client.query(
            `INSERT INTO indicator_monthly_entries
               (org_id, project_key, indicator_id, fy_start_year, month, scope, scope_value, plan, actual, remarks, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [orgId, projectKey, indicator.id, fyStartYear, month, scope, scopeValue, numOrNull(row.plan), numOrNull(row.actual), row.remarks || null, req.user.name || 'unknown']
          )
        }
        validCount++
      } else if (importType === 'beneficiary_master') {
        await client.query(
          `INSERT INTO beneficiary_mis_records
             (org_id, project_key, block, panchayat, village, beneficiary_name, farmer_id,
              contact_no, benf_type, cooperative_name, attributes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (org_id, project_key, block, sl_no, beneficiary_name)
             DO UPDATE SET panchayat = $4, village = $5, farmer_id = $7, contact_no = $8,
                           benf_type = $9, cooperative_name = $10, attributes = $11,
                           uploaded_by = $12, updated_at = NOW()`,
          [
            orgId, projectKey, String(row.block).trim(), row.panchayat || null, row.village || null,
            String(row.beneficiary_name).trim(), row.farmer_id || null, row.contact_no || null,
            row.benf_type || null, row.cooperative_name || null,
            JSON.stringify({ gender: row.gender || null }), req.user.name || 'unknown',
          ]
        )
        validCount++
      } else {
        // No live table for this import type yet — stage validated rows.
        await client.query(
          `INSERT INTO data_source_staged_rows (data_source_id, row_index, row_data, is_valid, errors)
           VALUES ($1,$2,$3,true,'[]'::jsonb)`,
          [req.params.id, i, JSON.stringify(row)]
        )
        validCount++
      }
    }

    const finalStatus = invalidCount === 0 ? 'imported' : (validCount === 0 ? 'validation_failed' : 'partially_imported')
    const { rows: [updated] } = await client.query(
      `UPDATE data_sources SET status = $1, row_counts = jsonb_set(row_counts, '{lastImportValid}', $2::jsonb), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [finalStatus, JSON.stringify(validCount), req.params.id]
    )
    await client.query(
      `INSERT INTO data_source_imports (data_source_id, imported_by, valid_count, invalid_count, duplicate_count, warning_count, mapping_config_snapshot)
       VALUES ($1,$2,$3,$4,0,0,$5)`,
      [req.params.id, req.user.name || 'unknown', validCount, invalidCount, JSON.stringify(dataSource.mapping_config || {})]
    )
    await client.query('COMMIT')

    logAudit(pool, { orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'data_source.import', targetId: req.params.id, diff: { importType, validCount, invalidCount } })
    res.json({ ok: true, dataSource: updated, validCount, invalidCount })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[data-sources import]', e)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    client.release()
  }
})

// POST /api/projects/:projectKey/data-sources/:id/sync — manual "Sync now".
// No per-org Google OAuth exists yet, so this always reports "Connection required".
router.post('/projects/:projectKey/data-sources/:id/sync', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const dataSource = await loadDataSource(pool, req.params.id, req.user.orgId, req.params.projectKey)
    if (!dataSource) return res.status(404).json({ error: 'Not found' })
    if (dataSource.source_type !== 'google_sheet') return res.status(400).json({ error: 'Sync only applies to Google Sheets sources' })

    await pool.query(`UPDATE data_sources SET status = 'sync_failed', updated_at = NOW() WHERE id = $1`, [req.params.id])
    res.status(409).json({
      error: 'Connection required',
      needsSetup: true,
      message: 'Google Sheets sync needs an authorised connection that has not been configured for this organisation yet.',
    })
  } catch (e) {
    console.error('[data-sources sync]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/projects/:projectKey/data-sources/:id/archive', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const { rows } = await getPool().query(
      `UPDATE data_sources SET status = 'archived', archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND org_id = $2 AND project_key = $3 RETURNING *`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    logAudit(getPool(), { orgId: req.user.orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'data_source.archive', targetId: req.params.id, diff: {} })
    res.json({ ok: true, dataSource: rows[0] })
  } catch (e) {
    console.error('[data-sources archive]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/projects/:projectKey/data-sources/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const { rowCount } = await getPool().query(
      `DELETE FROM data_sources WHERE id = $1 AND org_id = $2 AND project_key = $3`,
      [req.params.id, req.user.orgId, req.params.projectKey]
    )
    if (!rowCount) return res.status(404).json({ error: 'Not found' })
    logAudit(getPool(), { orgId: req.user.orgId, actorUid: req.user.uid, actorName: req.user.name, action: 'data_source.delete', targetId: req.params.id, diff: {} })
    res.json({ ok: true })
  } catch (e) {
    console.error('[data-sources delete]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── MIS Templates ────────────────────────────────────────────────────────
router.get('/mis-templates', (req, res) => {
  res.json({ templates: IMPORT_TYPES.map(t => ({ key: t.key, label: t.label, columns: t.columns })) })
})

router.get('/mis-templates/:key/schema', (req, res) => {
  const type = getImportType(req.params.key)
  if (!type) return res.status(404).json({ error: 'Unknown template' })
  res.json({ key: type.key, label: type.label, columns: type.columns })
})

router.get('/mis-templates/:key/xlsx', async (req, res) => {
  try {
    const type = getImportType(req.params.key)
    if (!type) return res.status(404).json({ error: 'Unknown template' })
    const buffer = await buildTemplateWorkbook(req.params.key)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${type.key}-template.xlsx"`)
    res.send(buffer)
  } catch (e) {
    console.error('[mis-templates xlsx]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
