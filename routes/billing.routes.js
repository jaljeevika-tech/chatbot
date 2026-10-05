// routes/billing.routes.js — AI usage billing & cost dashboard (superadmin only)
//
// GET  /api/superadmin/billing/summary?period=daily|weekly|monthly|all[&from=&to=]
// GET  /api/superadmin/billing/org/:id?period=...
// GET  /api/superadmin/billing/export.csv?period=...
// POST /api/superadmin/billing/backfill   — import all saved_reports as historical events

import { Router } from 'express'
import { requireSuperAdmin } from '../lib/auth.js'
import { getPool } from '../db/pool.js'
import { auditPlatform } from '../lib/platformAudit.js'

const router = Router()
router.use('/superadmin/billing', requireSuperAdmin)

// ── Date-range helper ─────────────────────────────────────────────────────────
// { from, to }; null means no date filter
function getRange(period = 'monthly', from, to) {
  if (period === 'all') return { from: null, to: null }
  if (from && to)       return { from: String(from), to: String(to) }
  const today = new Date().toISOString().slice(0, 10)
  if (period === 'daily')  return { from: today, to: today }
  const d = new Date()
  if (period === 'weekly') {
    d.setDate(d.getDate() - 6)
    return { from: d.toISOString().slice(0, 10), to: today }
  }
  // monthly = last 30 days
  d.setDate(d.getDate() - 29)
  return { from: d.toISOString().slice(0, 10), to: today }
}

// Date WHERE fragment + params; callers number their own params after these.
function dateCond(range, alias = 'u') {
  if (!range.from) return { cond: '', args: [] }
  return {
    cond: `AND ${alias}.created_at >= $1::date AND ${alias}.created_at < $2::date + INTERVAL '1 day'`,
    args: [range.from, range.to],
  }
}

// ── Ensure backfill columns exist (idempotent) ────────────────────────────────
async function ensureBackfillColumns(pool) {
  await pool.query(`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'`)
  await pool.query(`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ref_id  TEXT`)
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS usage_events_ref_id ON usage_events(ref_id) WHERE ref_id IS NOT NULL`
  )
}

// ── GET /api/superadmin/billing/summary ───────────────────────────────────────
router.get('/superadmin/billing/summary', async (req, res) => {
  const { period = 'monthly', from, to } = req.query
  const range = getRange(period, from, to)
  const { cond, args } = dateCond(range)

  try {
    const pool = getPool()
    // Older tables may lack source/ref_id
    await ensureBackfillColumns(pool).catch(() => {})
    const [totals, breakdown, series] = await Promise.all([

      // Per-org totals
      pool.query(`
        SELECT  u.org_id,
                o.name  AS org_name,
                o.slug  AS org_slug,
                ROUND(SUM(u.est_cost_usd)::numeric, 6)::float    AS total_cost_usd,
                COUNT(*)::int                                     AS total_calls,
                SUM(u.est_input_tokens)::int                      AS total_input_tokens,
                SUM(u.max_output_tokens)::int                     AS total_output_tokens,
                COUNT(*) FILTER (WHERE u.was_downgraded)::int     AS downgraded_calls,
                COUNT(*) FILTER (WHERE u.source = 'backfill')::int AS backfill_calls
        FROM    usage_events u
        JOIN    organizations o ON o.id::text = u.org_id
        WHERE   true ${cond}
        GROUP BY u.org_id, o.name, o.slug
        ORDER BY total_cost_usd DESC
      `, args),

      // Per-org per-service breakdown
      pool.query(`
        SELECT  u.org_id, u.service, u.model_tier,
                COUNT(*)::int                                     AS calls,
                ROUND(SUM(u.est_cost_usd)::numeric, 6)::float    AS cost_usd
        FROM    usage_events u
        WHERE   true ${cond}
        GROUP BY u.org_id, u.service, u.model_tier
        ORDER BY cost_usd DESC
      `, args),

      // Daily series for sparklines
      pool.query(`
        SELECT  u.org_id,
                DATE(u.created_at)                                AS day,
                ROUND(SUM(u.est_cost_usd)::numeric, 6)::float    AS cost_usd,
                COUNT(*)::int                                     AS calls
        FROM    usage_events u
        WHERE   true ${cond}
        GROUP BY u.org_id, DATE(u.created_at)
        ORDER BY day
      `, args),
    ])

    const bdMap = {}
    for (const r of breakdown.rows) { ;(bdMap[r.org_id] ??= []).push(r) }

    const seriesMap = {}
    for (const r of series.rows) {
      const day = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10)
      ;(seriesMap[r.org_id] ??= []).push({ day, cost_usd: r.cost_usd, calls: r.calls })
    }

    const orgs = totals.rows.map(r => ({
      ...r,
      by_service:   bdMap[r.org_id]    ?? [],
      daily_series: seriesMap[r.org_id] ?? [],
    }))

    res.json({
      period,
      from:               range.from,
      to:                 range.to,
      grand_total_usd:    +orgs.reduce((s, o) => s + (o.total_cost_usd  || 0), 0).toFixed(6),
      grand_total_calls:   orgs.reduce((s, o) => s + (o.total_calls     || 0), 0),
      orgs,
    })
  } catch (e) {
    console.error('[billing]', e); res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/superadmin/billing/org/:id ───────────────────────────────────────
router.get('/superadmin/billing/org/:id', async (req, res) => {
  const { id } = req.params
  const { period = 'monthly', from, to } = req.query
  const range = getRange(period, from, to)
  const dc    = dateCond(range)

  // org_id is $1 here, so shift date params $1/$2 → $2/$3 in one pass (two
  // sequential replaces would collapse both onto $3).
  const svcCond  = dc.cond.replace(/\$([12])/g, (_, n) => '$' + (Number(n) + 1))
  const svcArgs  = [id, ...dc.args]

  try {
    const pool = getPool()
    await ensureBackfillColumns(pool).catch(() => {})
    const [orgRes, svcRes, dayRes] = await Promise.all([
      pool.query(`SELECT id, name, slug FROM organizations WHERE id::text = $1`, [id]),

      pool.query(`
        SELECT service, model_tier,
               COUNT(*)::int                                     AS calls,
               ROUND(SUM(est_cost_usd)::numeric, 6)::float      AS cost_usd,
               SUM(est_input_tokens)::int                        AS input_tokens,
               SUM(max_output_tokens)::int                       AS output_tokens
        FROM   usage_events
        WHERE  org_id = $1 ${svcCond}
        GROUP BY service, model_tier
        ORDER BY cost_usd DESC
      `, svcArgs),

      pool.query(`
        SELECT DATE(created_at) AS day, service,
               COUNT(*)::int                                     AS calls,
               ROUND(SUM(est_cost_usd)::numeric, 6)::float      AS cost_usd
        FROM   usage_events
        WHERE  org_id = $1 ${svcCond}
        GROUP BY DATE(created_at), service
        ORDER BY day
      `, svcArgs),
    ])

    if (!orgRes.rows.length) return res.status(404).json({ error: 'Organization not found' })

    const daily = dayRes.rows.map(r => ({
      ...r,
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    }))

    res.json({
      org_id:         id,
      org_name:       orgRes.rows[0].name,
      org_slug:       orgRes.rows[0].slug,
      period,
      from:           range.from,
      to:             range.to,
      total_cost_usd: +svcRes.rows.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(6),
      total_calls:     svcRes.rows.reduce((s, r) => s + (r.calls    || 0), 0),
      by_service:      svcRes.rows,
      daily_series:    daily,
    })
  } catch (e) {
    console.error('[billing]', e); res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/superadmin/billing/backfill ─────────────────────────────────────
// Inserts a usage_events row per saved_report across all orgs. Idempotent via
// ON CONFLICT (ref_id) DO NOTHING, so reruns only add new reports.
router.post('/superadmin/billing/backfill', auditPlatform('billing.backfill', 'usage_events', { orgId: () => null, targetId: () => null }), async (req, res) => {
  const pool = getPool()
  try {
    await ensureBackfillColumns(pool)

    const { rows: reports } = await pool.query(`
      SELECT id, org_id, content, report_count, created_at
      FROM   saved_reports
      ORDER  BY created_at ASC
    `)

    if (!reports.length) {
      return res.json({ inserted: 0, skipped: 0, total: 0, message: 'No saved reports found' })
    }

    // Gemini Flash pricing (conservative — can't know whether Pro was used historically)
    const FLASH_IN  = 0.15 / 1_000_000
    const FLASH_OUT = 0.60 / 1_000_000

    let inserted = 0, skipped = 0

    for (const r of reports) {
      try {
        const reportCount     = parseInt(String(r.report_count || 0)) || 0
        const contentLen      = String(r.content || '').length
        // Input tokens: ~500 chars per field report in the prompt context + 3 KB system overhead
        const estInputTokens  = Math.ceil((reportCount * 500 + 3_000) / 4)
        // Output tokens from the actual generated content length
        const estOutputTokens = Math.ceil(contentLen / 4)
        const estCostUsd      = estInputTokens * FLASH_IN + estOutputTokens * FLASH_OUT

        const result = await pool.query(`
          INSERT INTO usage_events
            (org_id, service, model_tier,
             est_input_tokens, max_output_tokens, est_cost_usd,
             was_downgraded, source, ref_id, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (ref_id) DO NOTHING
        `, [
          String(r.org_id),
          'report_ai',
          'flash',
          estInputTokens,
          estOutputTokens,
          +estCostUsd.toFixed(6),
          false,
          'backfill',
          `sr_${r.id}`,
          r.created_at,
        ])

        if (result.rowCount > 0) inserted++
        else skipped++
      } catch (rowErr) {
        skipped++
        console.warn('[billing/backfill] row error:', rowErr.message)
      }
    }

    res.json({
      inserted,
      skipped,
      total:   reports.length,
      message: `Imported ${inserted} historical report${inserted !== 1 ? 's' : ''}`
                + (skipped > 0 ? ` · ${skipped} already present` : ''),
    })
  } catch (e) {
    console.error('[billing]', e); res.status(500).json({ error: 'Internal server error' })
  }
})

// RFC 4180 quoting + neutralise spreadsheet formulas (=,+,-,@) so an org
// name like =HYPERLINK(...) can't execute when the CSV is opened in Excel.
function csvCell(v) {
  let s = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return '"' + s.replace(/"/g, '""') + '"'
}

// ── GET /api/superadmin/billing/export.csv ────────────────────────────────────
router.get('/superadmin/billing/export.csv', async (req, res) => {
  const { period = 'monthly', from, to } = req.query
  const range = getRange(period, from, to)
  const { cond, args } = dateCond(range)
  try {
    const pool = getPool()
    await ensureBackfillColumns(pool).catch(() => {})
    const { rows } = await pool.query(`
      SELECT  o.name AS org_name, o.slug,
              DATE(u.created_at)                                AS date,
              u.service, u.model_tier,
              COALESCE(u.source, 'live')                        AS source,
              COUNT(*)::int                                     AS calls,
              SUM(u.est_input_tokens)::int                      AS input_tokens,
              SUM(u.max_output_tokens)::int                     AS output_tokens,
              ROUND(SUM(u.est_cost_usd)::numeric, 6)::float    AS cost_usd
      FROM    usage_events u
      JOIN    organizations o ON o.id::text = u.org_id
      WHERE   true ${cond}
      GROUP BY o.name, o.slug, DATE(u.created_at), u.service, u.model_tier, COALESCE(u.source,'live')
      ORDER BY o.name, date, cost_usd DESC
    `, args)

    const toDateStr = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
    const label  = range.from ? `${range.from}-to-${range.to}` : 'all-time'
    const header = 'org_name,slug,date,service,model_tier,source,calls,input_tokens,output_tokens,est_cost_usd'
    const csv    = [
      header,
      ...rows.map(r =>
        [csvCell(r.org_name), csvCell(r.slug), toDateStr(r.date), r.service, r.model_tier, r.source,
         r.calls, r.input_tokens, r.output_tokens, r.cost_usd.toFixed(6)].join(',')
      ),
    ].join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="fieldflow-billing-${label}.csv"`)
    res.send(csv)
  } catch (e) {
    console.error('[billing]', e); res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
