// Beneficiary Registration > Dashboard: org-wide coverage and headcounts across
// the Individual / Micro-Entrepreneur / Collective registries plus Resources
// (none carry a project_key). Resources have no location columns, so they take
// their place from the owning beneficiary; byState / byLocation / locationGeocodes /
// resourceLocations feed the charts and LocationDrilldown map.
//
//   GET  /api/beneficiary-registration-dashboard
//          ?state=&district=&block=&village=
//          &beneficiary_type=individual|entrepreneur|collective
//          &gender=Male|Female|Other &category=General|OBC|EBC|SC|ST|EWS|Minority
//          &production_system=Aquaculture|Agriculture|Livestock|Horticulture
//          &from=YYYY-MM-DD &to=YYYY-MM-DD      (all optional — see parseFilters)
//   POST /api/beneficiary-registration-dashboard/geocode-locations

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { requireEditor, requireAdmin } from '../lib/routeGuards.js'
import { locationKey, geocodePlace, sleep } from '../lib/geocodeLocation.js'
import { decryptRowInPlace } from '../lib/piiCrypto.js'
import { placeCoordsFor } from '../lib/placeCoords.js'

const router = Router()

// Option lists mirror the registration forms (services/*/index.js) — listed
// even at zero so the dashboard always shows the full set.
const COLLECTIVE_TYPES      = ['FPO', 'SHG', 'Cooperative', 'MCMC', 'PG', 'Vendor Collective']
const RESOURCE_TYPES        = ['Freshwater Wetland', 'Coastal Wetland', 'Agricultural Land', 'Brackish Water']
const PRODUCTION_SYSTEMS    = ['Aquaculture', 'Agriculture', 'Livestock', 'Horticulture']
const CATEGORIES            = ['General', 'OBC', 'EBC', 'SC', 'ST', 'EWS', 'Minority']
const WATER_BODY_TYPES      = ['Chour', 'Moen', 'Dhar', 'Pond']
const RESOURCE_ACCESS_TYPES = ['Owned', 'Leased', 'Common']
const WETLAND_STRUCTURES    = ['Raft', 'Mangroves']

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// Production System entries (067/068/069), falling back to the legacy single
// production_type + current_production_ton (Ton → Quintal ×10) on older rows.
function productionEntries(r) {
  if (Array.isArray(r.production_systems) && r.production_systems.length) return r.production_systems
  if (r.production_type) {
    const ton = num(r.current_production_ton)
    return [{ type: r.production_type, production_quintal: ton == null ? null : ton * 10 }]
  }
  return []
}

// Case/whitespace-insensitive place-name match (registrations mix "KHAGARIA"
// and "Khagaria"-style entries for the same place).
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

// Invalid filter values are ignored, not rejected, so stale bookmarks still load.
const BENEFICIARY_TYPE_KEYS = ['individual', 'entrepreneur', 'collective']
const GENDERS = ['Male', 'Female', 'Other']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
function parseFilters(q) {
  const s = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    state: s(q.state), district: s(q.district), block: s(q.block), village: s(q.village),
    beneficiaryType:  BENEFICIARY_TYPE_KEYS.includes(q.beneficiary_type) ? q.beneficiary_type : null,
    gender:           GENDERS.includes(q.gender) ? q.gender : null,
    category:         CATEGORIES.includes(q.category) ? q.category : null,
    productionSystem: PRODUCTION_SYSTEMS.includes(q.production_system) ? q.production_system : null,
    from: ISO_DATE.test(q.from || '') ? q.from : null,
    to:   ISO_DATE.test(q.to || '') ? q.to : null,
  }
}

// Nominatim allows 1 req/sec and no heavy bulk use; cap per call so the request
// fits an HTTP timeout. Repeat the call to work through a backlog.
const GEOCODE_BATCH_LIMIT = 20
const GEOCODE_DELAY_MS = 1100

router.get('/beneficiary-registration-dashboard', async (req, res) => {
  if (!requireEditor(req, res)) return
  try {
    const pool  = getPool()
    const orgId = req.user.orgId

    // Aggregated in app code, not SQL: since 064 panchayat and income/revenue are
    // only in *_enc columns, so SQL GROUP BY would miss every newer row.
    // decryptRowInPlace handles both shapes. Fine at this org's scale.
    const [ibRes, meRes, cbRes, rsRes] = await Promise.all([
      pool.query(
        `SELECT uid, created_at, state, district, block, panchayat, panchayat_enc, village, gender, category,
                member_of_collective, current_income_inr, current_income_inr_enc,
                production_type, current_production_ton, production_systems
         FROM individual_beneficiaries WHERE org_id = $1`,
        [orgId]
      ),
      pool.query(
        `SELECT uid, created_at, state, district, block, panchayat, panchayat_enc, village, gender, category,
                current_revenue_inr, current_revenue_inr_enc, current_employee_count, production_systems
         FROM micro_entrepreneurs WHERE org_id = $1`,
        [orgId]
      ),
      pool.query(
        `SELECT uid, created_at, state, district, block, panchayat, panchayat_enc, village, collective_type,
                male_count, female_count, current_revenue_inr, credit_access_inr,
                production_type, current_production_ton, production_systems
         FROM collectives WHERE org_id = $1`,
        [orgId]
      ),
      pool.query(
        `SELECT id, created_at, beneficiary_uid, beneficiary_type, resource_type, water_body_type, resource_access,
                wetland_structure, area_acre, raft_count, resource_utility,
                latitude::float8 AS latitude, longitude::float8 AS longitude
         FROM resources WHERE org_id = $1`,
        [orgId]
      ),
    ])
    const ibAllRows = ibRes.rows.map(r => decryptRowInPlace('individual_beneficiaries', r))
    const meAllRows = meRes.rows.map(r => decryptRowInPlace('micro_entrepreneurs', r))
    const cbAllRows = cbRes.rows.map(r => decryptRowInPlace('collectives', r))

    // ── Filters (all optional) ─────────────────────────────────────────────
    // Resources follow their beneficiaries; the date range uses each registry's created_at.
    const f = parseFilters(req.query)
    const inDate = row => {
      if (!f.from && !f.to) return true
      const d = row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null
      if (!d) return false
      return (!f.from || d >= f.from) && (!f.to || d <= f.to)
    }
    const applyFilters = (rows, typeKey, { ignoreDate = false } = {}) => {
      if (f.beneficiaryType && f.beneficiaryType !== typeKey) return []
      // Collectives have no gender/social category, so those filters exclude them.
      if ((f.gender || f.category) && typeKey === 'collective') return []
      return rows.filter(r =>
        (!f.state    || same(r.state, f.state)) &&
        (!f.district || same(r.district, f.district)) &&
        (!f.block    || same(r.block, f.block)) &&
        (!f.village  || same(r.village, f.village)) &&
        (!f.gender   || r.gender === f.gender) &&
        (!f.category || r.category === f.category) &&
        (!f.productionSystem || productionEntries(r).some(e => e && e.type === f.productionSystem)) &&
        (ignoreDate || inDate(r))
      )
    }
    const ibAll = applyFilters(ibAllRows, 'individual')
    const meAll = applyFilters(meAllRows, 'entrepreneur')
    const cbAll = applyFilters(cbAllRows, 'collective')
    const allLocations = [...ibAll, ...meAll, ...cbAll]

    // Cascading dropdowns: each level scoped only by the levels above it, over
    // unfiltered rows (same rule as individual-beneficiaries' scopedDistinct).
    const everyone = [...ibAllRows, ...meAllRows, ...cbAllRows]
    const optionsFor = (field, ancestors) => [...new Set(
      everyone.filter(r => ancestors.every(([k, v]) => !v || same(r[k], v))).map(r => r[field]).filter(v => v != null && String(v).trim() !== '')
    )].sort((a, b) => String(a).localeCompare(String(b)))
    const filterOptions = {
      states:    optionsFor('state', []),
      districts: optionsFor('district', [['state', f.state]]),
      blocks:    optionsFor('block', [['state', f.state], ['district', f.district]]),
      villages:  optionsFor('village', [['state', f.state], ['district', f.district], ['block', f.block]]),
    }

    // Geographic coverage across the three registries combined
    const distinctCount = field => new Set(allLocations.map(r => r[field]).filter(v => v != null && String(v).trim() !== '')).size
    const coverage = {
      states: distinctCount('state'), districts: distinctCount('district'), blocks: distinctCount('block'),
      panchayats: distinctCount('panchayat'), villages: distinctCount('village'),
    }

    // One row per location combination, split by beneficiary type for the map.
    const locationTotals = new Map()
    const tally = (rows, typeKey) => {
      for (const r of rows) {
        if (!(r.state || r.district || r.block || r.panchayat || r.village)) continue
        const loc = { state: r.state || null, district: r.district || null, block: r.block || null, panchayat: r.panchayat || null, village: r.village || null }
        const key = JSON.stringify(loc)
        let entry = locationTotals.get(key)
        if (!entry) locationTotals.set(key, entry = { ...loc, total: 0, individual: 0, entrepreneur: 0, collective: 0 })
        entry.total++
        entry[typeKey]++
      }
    }
    tally(ibAll, 'individual')
    tally(meAll, 'entrepreneur')
    tally(cbAll, 'collective')
    const byLocationRows = [...locationTotals.values()].sort((a, b) =>
      ['state', 'district', 'block', 'panchayat', 'village'].reduce((c, f) => c || String(a[f] || '').localeCompare(String(b[f] || '')), 0)
    )

    const countBy = (rows, field, known) => {
      const m = new Map()
      for (const r of rows) if (r[field]) m.set(r[field], (m.get(r[field]) || 0) + 1)
      const extra = [...m.keys()].filter(k => !known.includes(k))
      return [...known, ...extra].map(label => ({ label, total: m.get(label) || 0 }))
    }
    const sumOf = (rows, field) => rows.reduce((s, r) => s + (num(r[field]) || 0), 0)
    const avgOf = (rows, field) => {
      const vals = rows.map(r => num(r[field])).filter(v => v != null)
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    }

    const productionBreakdown = rows => {
      const m = new Map(PRODUCTION_SYSTEMS.map(t => [t, { type: t, count: 0, quintal: 0, livestock: 0 }]))
      for (const r of rows) {
        const seen = new Set()
        for (const e of productionEntries(r)) {
          if (!e || !e.type || seen.has(e.type)) continue
          seen.add(e.type)
          if (!m.has(e.type)) m.set(e.type, { type: e.type, count: 0, quintal: 0, livestock: 0 })
          const agg = m.get(e.type)
          agg.count++
          agg.quintal   += num(e.production_quintal) || 0
          agg.livestock += num(e.livestock_count) || 0
        }
      }
      return [...m.values()]
    }
    const productionSummary = rows => {
      const byType = productionBreakdown(rows)
      return {
        byType,
        totalQuintal:   byType.reduce((s, t) => s + t.quintal, 0),
        totalLivestock: byType.reduce((s, t) => s + t.livestock, 0),
        withProduction: rows.filter(r => productionEntries(r).length > 0).length,
      }
    }

    // ── Resources — follow the beneficiary each is registered against ──────
    // Located via beneficiary_uid + beneficiary_type. With a beneficiary filter
    // active, only resources of matching beneficiaries count.
    const TYPE_LABEL_TO_KEY = { 'Individual Beneficiary': 'individual', 'Micro-Entrepreneur': 'entrepreneur', 'Collective': 'collective' }
    const ownerKey = (typeKey, uid) => `${typeKey}|${uid}`
    const ownerAll = new Map([
      ...ibAllRows.map(r => [ownerKey('individual', r.uid), r]),
      ...meAllRows.map(r => [ownerKey('entrepreneur', r.uid), r]),
      ...cbAllRows.map(r => [ownerKey('collective', r.uid), r]),
    ])
    const beneficiaryFilterActive = !!(f.state || f.district || f.block || f.village || f.beneficiaryType || f.gender || f.category || f.productionSystem)
    const ownerMatches = new Set([
      ...applyFilters(ibAllRows, 'individual', { ignoreDate: true }).map(r => ownerKey('individual', r.uid)),
      ...applyFilters(meAllRows, 'entrepreneur', { ignoreDate: true }).map(r => ownerKey('entrepreneur', r.uid)),
      ...applyFilters(cbAllRows, 'collective', { ignoreDate: true }).map(r => ownerKey('collective', r.uid)),
    ])
    const rsAllRows = rsRes.rows.filter(r =>
      inDate(r) &&
      (!beneficiaryFilterActive || ownerMatches.has(ownerKey(TYPE_LABEL_TO_KEY[r.beneficiary_type], r.beneficiary_uid)))
    )
    const ownerOf = r => ownerAll.get(ownerKey(TYPE_LABEL_TO_KEY[r.beneficiary_type], r.beneficiary_uid))

    const rsAreaByType = new Map()
    for (const r of rsAllRows) {
      if (!r.resource_type) continue
      rsAreaByType.set(r.resource_type, (rsAreaByType.get(r.resource_type) || 0) + (num(r.area_acre) || 0))
    }
    // Resource Utility is a JSONB array whose shape varies by branch (045).
    const utilityTotals = new Map()
    for (const r of rsAllRows) {
      for (const u of Array.isArray(r.resource_utility) ? r.resource_utility : []) {
        if (!u || !u.utility) continue
        const agg = utilityTotals.get(u.utility) || { utility: u.utility, resourceCount: 0, totalKg: 0 }
        agg.resourceCount++
        agg.totalKg += num(u.production_kg) || 0
        utilityTotals.set(u.utility, agg)
      }
    }
    const utilityBreakdown = [...utilityTotals.values()].sort((a, b) => b.totalKg - a.totalKg)

    // ── Blended graph: registrations by State ──────────────────────────────
    const stateRows = new Map()
    const bump = (state, key) => {
      if (!state) return
      const row = stateRows.get(state) || { state, individualBeneficiaries: 0, microEntrepreneurs: 0, collectives: 0, resources: 0 }
      row[key]++
      stateRows.set(state, row)
    }
    ibAll.forEach(r => bump(r.state, 'individualBeneficiaries'))
    meAll.forEach(r => bump(r.state, 'microEntrepreneurs'))
    cbAll.forEach(r => bump(r.state, 'collectives'))
    rsAllRows.forEach(r => bump(ownerOf(r)?.state, 'resources'))
    const byState = [...stateRows.values()].sort((a, b) => a.state.localeCompare(b.state))

    // ── Map: geo-tagged resource locations ──────────────────────────────────
    // Only resources have coordinates; beneficiary_type says who owns each point.
    const resourceLocations = rsAllRows
      .filter(r => r.latitude != null && r.longitude != null)
      .map(({ id, resource_type, beneficiary_type, latitude, longitude }) => ({ id, resource_type, beneficiary_type, latitude, longitude }))

    // Village positions without geocoding: average GPS of resources registered
    // against beneficiaries in that village (captured on site).
    const { rows: villageGps } = await pool.query(
      `SELECT state, district, block, village,
              avg(latitude)::float8 AS latitude, avg(longitude)::float8 AS longitude, count(*)::int AS resources
       FROM (
         SELECT ib.state, ib.district, ib.block, ib.village, r.latitude, r.longitude
           FROM resources r JOIN individual_beneficiaries ib ON ib.org_id = r.org_id AND ib.uid = r.beneficiary_uid
           WHERE r.org_id = $1 AND r.beneficiary_type = 'Individual Beneficiary'
         UNION ALL
         SELECT me.state, me.district, me.block, me.village, r.latitude, r.longitude
           FROM resources r JOIN micro_entrepreneurs me ON me.org_id = r.org_id AND me.uid = r.beneficiary_uid
           WHERE r.org_id = $1 AND r.beneficiary_type = 'Micro-Entrepreneur'
         UNION ALL
         SELECT cb.state, cb.district, cb.block, cb.village, r.latitude, r.longitude
           FROM resources r JOIN collectives cb ON cb.org_id = r.org_id AND cb.uid = r.beneficiary_uid
           WHERE r.org_id = $1 AND r.beneficiary_type = 'Collective'
       ) g
       WHERE village IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
       GROUP BY state, district, block, village`,
      [orgId]
    )

    // Optional cache: missing table (42P01) falls back to approximate positions.
    // location_geocodes is platform-wide (no org_id), so filter it to this org's
    // own places — otherwise it reveals where other orgs work.
    let locationGeocodes = []
    try {
      const ownKeys = new Set()
      for (const r of byLocationRows) {
        ownKeys.add(locationKey({ state: r.state, district: r.district }))
        ownKeys.add(locationKey({ state: r.state, district: r.district, block: r.block }))
        ownKeys.add(locationKey({ state: r.state, district: r.district, block: r.block, village: r.village }))
      }
      const { rows: allGeo } = await pool.query(
        `SELECT state, district, block, village, latitude::float8 AS latitude, longitude::float8 AS longitude
         FROM location_geocodes WHERE geocode_status = 'found'`
      )
      locationGeocodes = allGeo.filter(g => ownKeys.has(locationKey(g)))
    } catch (geoErr) {
      if (geoErr.code !== '42P01') throw geoErr
      console.warn('[beneficiary-registration-dashboard GET] location_geocodes missing — run migration 072')
    }

    const genderSplit = rows => ({
      male:   rows.filter(r => r.gender === 'Male').length,
      female: rows.filter(r => r.gender === 'Female').length,
      other:  rows.filter(r => r.gender === 'Other').length,
    })
    const byTypeOf = list => list.map(d => ({ type: d.label, total: d.total }))

    res.json({
      coverage,
      individualBeneficiaries: {
        total: ibAll.length,
        ...genderSplit(ibAll),
        byCategory: countBy(ibAll, 'category', CATEGORIES),
        collectiveMembers: ibAll.filter(r => r.member_of_collective === true).length,
        avgIncome: avgOf(ibAll, 'current_income_inr'),
        production: productionSummary(ibAll),
      },
      microEntrepreneurs: {
        total: meAll.length,
        ...genderSplit(meAll),
        byCategory: countBy(meAll, 'category', CATEGORIES),
        totalEmployees: sumOf(meAll, 'current_employee_count'),
        totalRevenue: sumOf(meAll, 'current_revenue_inr'),
        avgRevenue: avgOf(meAll, 'current_revenue_inr'),
        production: productionSummary(meAll),
      },
      collectives: {
        total: cbAll.length,
        // Every known type, even at zero
        byType: byTypeOf(countBy(cbAll, 'collective_type', COLLECTIVE_TYPES)),
        totalMale:   sumOf(cbAll, 'male_count'),
        totalFemale: sumOf(cbAll, 'female_count'),
        totalRevenue: sumOf(cbAll, 'current_revenue_inr'),
        totalCreditAccess: sumOf(cbAll, 'credit_access_inr'),
        production: productionSummary(cbAll),
      },
      // All three registries combined
      production: productionSummary([...ibAll, ...meAll, ...cbAll]),
      resources: {
        total: rsAllRows.length,
        byType: byTypeOf(countBy(rsAllRows, 'resource_type', RESOURCE_TYPES)).map(t => ({ ...t, areaAcre: rsAreaByType.get(t.type) || 0 })),
        byWaterBodyType:    byTypeOf(countBy(rsAllRows.filter(r => r.resource_type === 'Freshwater Wetland'), 'water_body_type', WATER_BODY_TYPES)),
        byAccess:           byTypeOf(countBy(rsAllRows.filter(r => r.resource_type === 'Freshwater Wetland'), 'resource_access', RESOURCE_ACCESS_TYPES)),
        byWetlandStructure: byTypeOf(countBy(rsAllRows.filter(r => r.resource_type === 'Coastal Wetland'), 'wetland_structure', WETLAND_STRUCTURES)),
        totalAreaAcre:  sumOf(rsAllRows, 'area_acre'),
        totalRaftCount: sumOf(rsAllRows, 'raft_count'),
        utilityBreakdown,
      },
      filters: f,
      filterOptions,
      byState,
      byLocation: byLocationRows,
      locationGeocodes,
      // Static LGD-matched coordinates (lib/placeCoords.js) for this org's places.
      placeCoords: placeCoordsFor(byLocationRows),
      villageGps,
      resourceLocations,
    })
  } catch (e) {
    console.error('[beneficiary-registration-dashboard GET]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/beneficiary-registration-dashboard/geocode-locations
// Admin-triggered geocoding for one drill-down level, scoped to the current selection:
//   level='district'                          → every District in the org
//   level='block',   state+district given     → every Block in that District
//   level='village',  state+district+block given → every Village in that Block
// Skips cached places and resolves up to GEOCODE_BATCH_LIMIT via Nominatim with a
// GEOCODE_DELAY_MS gap. Never automatic: it calls a third-party service.
router.post('/beneficiary-registration-dashboard/geocode-locations', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const { level, state, district, block } = req.body || {}
  if (!['district', 'block', 'village'].includes(level)) {
    return res.status(400).json({ error: 'level must be district, block, or village' })
  }
  if (level === 'block' && !(state && district)) {
    return res.status(400).json({ error: 'state and district are required for level=block' })
  }
  if (level === 'village' && !(state && district && block)) {
    return res.status(400).json({ error: 'state, district, and block are required for level=village' })
  }
  try {
    const pool  = getPool()
    const orgId = req.user.orgId

    // Distinct target-level names across the registries, filtered by any ancestors picked.
    const column = level === 'district' ? 'district' : level === 'block' ? 'block' : 'village'
    const filters = []
    const params = [orgId]
    if (state)    { params.push(state);    filters.push(`state = $${params.length}`) }
    if (district) { params.push(district); filters.push(`district = $${params.length}`) }
    if (block)    { params.push(block);    filters.push(`block = $${params.length}`) }
    const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : ''

    const { rows: targets } = await pool.query(
      `SELECT DISTINCT state, district, block, village
       FROM (
         SELECT state, district, block, village FROM individual_beneficiaries WHERE org_id = $1
         UNION ALL
         SELECT state, district, block, village FROM micro_entrepreneurs      WHERE org_id = $1
         UNION ALL
         SELECT state, district, block, village FROM collectives              WHERE org_id = $1
       ) combined
       WHERE ${column} IS NOT NULL ${whereExtra}`,
      params
    )

    // Collapse to the target level so each Block etc. is geocoded once.
    const seen = new Set()
    const places = []
    for (const t of targets) {
      const place = {
        state: t.state,
        district: level === 'district' ? t.district : district || t.district,
        block:    level === 'village'  ? t.block    : (level === 'block' ? t.block : null),
        village:  level === 'village'  ? t.village  : null,
      }
      const key = locationKey(place)
      if (seen.has(key)) continue
      seen.add(key)
      places.push(place)
    }

    const { rows: cachedRows } = await pool.query(`SELECT location_key FROM location_geocodes`)
    const cachedKeys = new Set(cachedRows.map(r => r.location_key))
    const pending = places.filter(p => !cachedKeys.has(locationKey(p)))
    const batch = pending.slice(0, GEOCODE_BATCH_LIMIT)

    let found = 0, notFound = 0, failed = 0
    for (let i = 0; i < batch.length; i++) {
      const place = batch[i]
      try {
        const result = await geocodePlace(place)
        if (result) {
          await pool.query(
            `INSERT INTO location_geocodes (state, district, block, village, latitude, longitude, geocode_status, geocoded_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'found', now())
             ON CONFLICT (location_key) DO UPDATE SET
               latitude = excluded.latitude, longitude = excluded.longitude,
               geocode_status = 'found', geocoded_at = now()`,
            [place.state, place.district, place.block, place.village, result.latitude, result.longitude]
          )
          found++
        } else {
          await pool.query(
            `INSERT INTO location_geocodes (state, district, block, village, geocode_status, geocoded_at)
             VALUES ($1, $2, $3, $4, 'not_found', now())
             ON CONFLICT (location_key) DO UPDATE SET geocode_status = 'not_found', geocoded_at = now()`,
            [place.state, place.district, place.block, place.village]
          )
          notFound++
        }
      } catch (geocodeErr) {
        console.error('[geocode-locations] lookup failed', place, geocodeErr.message)
        failed++
      }
      if (i < batch.length - 1) await sleep(GEOCODE_DELAY_MS)
    }

    res.json({
      attempted: batch.length,
      found,
      notFound,
      failed,
      remaining: pending.length - batch.length,
    })
  } catch (e) {
    console.error('[beneficiary-registration-dashboard geocode-locations POST]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
