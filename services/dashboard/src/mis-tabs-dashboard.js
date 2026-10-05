// MIS > Dashboard: read-only rollup of the ten MIS upload categories for one
// project (046, 048-056, 071; scoping in 058). Eight link to a beneficiary;
// Campaign and Community Meeting are aggregate events with headcounts, so only
// they feed gender/attendee totals and only the eight feed beneficiary counts.
//
//   GET /api/projects/:projectKey/mis-tabs-dashboard

import { Router } from 'express'
import { getPool } from './pool.js'
import { requireEditor } from '../../../lib/routeGuards.js'

const router = Router()

// Per-category totals, one query shape per table. Campaign/Community Meeting return
// NULL unique_beneficiaries so Promise.all results line up with CATEGORY_META.
const CATEGORY_META = [
  { key: 'training',         label: 'Training',                       table: 'trainings',                      dateCol: 'training_date' },
  // Income has no per-record date (financial_year is text), so created_at stands in.
  { key: 'income',           label: 'Income',                         table: 'income',                         dateCol: 'created_at' },
  { key: 'inputdistribution',label: 'Input Distribution',             table: 'input_distributions',            dateCol: 'distribution_date' },
  { key: 'schemeaccess',     label: 'Scheme Access',                  table: 'scheme_access',                  dateCol: 'access_date' },
  { key: 'creditgrant',      label: 'Credit/Grant Access',            table: 'credit_grant_access',            dateCol: 'access_date' },
  { key: 'bds',              label: 'Business Development Support',   table: 'business_development_support',   dateCol: 'support_date' },
  { key: 'compliance',       label: 'Compliance Support',             table: 'compliance_support',             dateCol: 'support_date' },
  { key: 'exposurevisit',    label: 'Exposure Visit',                 table: 'exposure_visits',                dateCol: 'visit_date' },
  { key: 'campaign',         label: 'Campaign',                       table: 'campaign',                       dateCol: 'campaign_date',  event: true },
  { key: 'communitymeeting', label: 'Community Meeting',              table: 'community_meeting',              dateCol: 'meeting_date',   event: true },
]

const BENEFICIARY_TABLES = CATEGORY_META.filter(c => !c.event).map(c => c.table)

// GET /api/projects/:projectKey/mis-tabs-dashboard
router.get('/projects/:projectKey/mis-tabs-dashboard', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool = getPool()
    const { projectKey } = req.params
    const orgId = req.user.orgId
    const args = [orgId, projectKey]

    const categoryQueries = CATEGORY_META.map(c => {
      if (c.event) {
        return pool.query(
          `SELECT count(*)::int AS total,
                  NULL::int AS unique_beneficiaries,
                  max(${c.dateCol}) AS last_date,
                  max(created_at) AS last_upload,
                  coalesce(sum(total_attendees), 0)::int AS total_attendees
           FROM ${c.table} WHERE org_id = $1 AND project_key = $2`,
          args
        )
      }
      const amountCol = c.key === 'creditgrant' ? ', coalesce(sum(amount), 0)::float8 AS total_amount'
        : c.key === 'income' ? ', coalesce(sum(income_realised), 0)::float8 AS total_amount'
        : ''
      return pool.query(
        `SELECT count(*)::int AS total,
                count(DISTINCT beneficiary_uid)::int AS unique_beneficiaries,
                max(${c.dateCol}) AS last_date,
                max(created_at) AS last_upload
                ${amountCol}
         FROM ${c.table} WHERE org_id = $1 AND project_key = $2`,
        args
      )
    })

    const beneficiaryTypeQuery = pool.query(
      `WITH all_b AS (
         ${BENEFICIARY_TABLES.map(t => `SELECT beneficiary_uid, beneficiary_type FROM ${t} WHERE org_id = $1 AND project_key = $2`).join('\n         UNION\n         ')}
       )
       SELECT beneficiary_type AS label, count(*)::int AS total FROM all_b GROUP BY beneficiary_type ORDER BY total DESC`,
      args
    )

    // Normalize each category's place column (exposure_visits uses visit_place, see 054).
    const placeSelects = CATEGORY_META.map(c => {
      const col = c.key === 'exposurevisit' ? 'visit_place' : 'place'
      return `SELECT ${col} AS loc FROM ${c.table} WHERE org_id = $1 AND project_key = $2 AND ${col} IS NOT NULL AND ${col} <> ''`
    })
    const topLocationsQuery = pool.query(
      `WITH all_places AS (${placeSelects.join('\n         UNION ALL\n         ')})
       SELECT loc AS label, count(*)::int AS total FROM all_places GROUP BY loc ORDER BY total DESC LIMIT 10`,
      args
    )

    const genderQuery = pool.query(
      `SELECT coalesce(sum(male_count), 0)::int AS male,
              coalesce(sum(female_count), 0)::int AS female,
              coalesce(sum(children_count), 0)::int AS children,
              coalesce(sum(total_attendees), 0)::int AS attendees
       FROM (
         SELECT male_count, female_count, children_count, total_attendees FROM campaign WHERE org_id = $1 AND project_key = $2
         UNION ALL
         SELECT male_count, female_count, children_count, total_attendees FROM community_meeting WHERE org_id = $1 AND project_key = $2
       ) x`,
      args
    )

    const monthlySelects = CATEGORY_META.map(c =>
      `SELECT '${c.key}' AS category, date_trunc('month', ${c.dateCol})::date AS month, count(*)::int AS total
       FROM ${c.table} WHERE org_id = $1 AND project_key = $2 AND ${c.dateCol} IS NOT NULL GROUP BY 2`
    )
    const monthlyTrendQuery = pool.query(
      `${monthlySelects.join('\n       UNION ALL\n       ')}
       ORDER BY month ASC`,
      args
    )

    const [categoryResults, beneficiaryTypeResult, topLocationsResult, genderResult, monthlyTrendResult] = await Promise.all([
      Promise.all(categoryQueries), beneficiaryTypeQuery, topLocationsQuery, genderQuery, monthlyTrendQuery,
    ])

    const categories = CATEGORY_META.map((c, i) => {
      const row = categoryResults[i].rows[0] || {}
      return {
        key: c.key,
        label: c.label,
        total: row.total || 0,
        uniqueBeneficiaries: row.unique_beneficiaries ?? null,
        lastActivityDate: row.last_date || null,
        lastUpload: row.last_upload || null,
        ...(c.key === 'creditgrant' || c.key === 'income' ? { totalAmount: Number(row.total_amount) || 0 } : {}),
        ...(c.event ? { totalAttendees: row.total_attendees || 0 } : {}),
      }
    })

    const totalRecords = categories.reduce((s, c) => s + c.total, 0)
    const eventCategories = categories.filter(c => CATEGORY_META.find(m => m.key === c.key)?.event)
    const beneficiaryTypeBreakdown = beneficiaryTypeResult.rows.map(r => ({ label: r.label, total: r.total }))
    const uniqueBeneficiariesReached = beneficiaryTypeBreakdown.reduce((s, r) => s + r.total, 0)

    // One row per month, a column per category, ready for a stacked recharts series.
    const monthMap = new Map()
    for (const r of monthlyTrendResult.rows) {
      const key = r.month.toISOString().slice(0, 7) // YYYY-MM
      if (!monthMap.has(key)) {
        const entry = { month: key }
        CATEGORY_META.forEach(c => { entry[c.key] = 0 })
        monthMap.set(key, entry)
      }
      monthMap.get(key)[r.category] = r.total
    }
    const monthlyTrend = Array.from(monthMap.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12)
      .map(entry => ({ ...entry, total: CATEGORY_META.reduce((s, c) => s + (entry[c.key] || 0), 0) }))

    const gender = genderResult.rows[0] || { male: 0, female: 0, children: 0, attendees: 0 }

    res.json({
      categories,
      totals: {
        totalRecords,
        uniqueBeneficiariesReached,
        totalEvents: eventCategories.reduce((s, c) => s + c.total, 0),
        totalEventAttendees: gender.attendees || 0,
        totalCreditGrantAmount: categories.find(c => c.key === 'creditgrant')?.totalAmount || 0,
        totalIncomeAmount: categories.find(c => c.key === 'income')?.totalAmount || 0,
      },
      beneficiaryTypeBreakdown,
      topLocations: topLocationsResult.rows.map(r => ({ label: r.label, total: r.total })),
      genderBreakdown: { male: gender.male || 0, female: gender.female || 0, children: gender.children || 0 },
      monthlyTrend,
    })
  } catch (e) {
    console.error('[mis-tabs-dashboard GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
