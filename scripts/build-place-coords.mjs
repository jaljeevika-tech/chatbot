#!/usr/bin/env node
/**
 * scripts/build-place-coords.mjs
 * ──────────────────────────────
 * Builds db/seed-data/lgd/place-coords.json.gz — a static District / Block /
 * Village → [lat, lng] table covering ALL of India, so the Beneficiary
 * Registration Dashboard's location map places every current AND future
 * registration at its real position with no runtime geocoding
 * (lib/placeCoords.js reads it; routes/beneficiary-dashboard.routes.js
 * returns the entries an org actually uses).
 *
 * How places are matched — by official LGD code, never by guessing names:
 *   1. Wikidata items carry the same LGD codes as our LGD seed data
 *      (db/seed-data/lgd, see README.md): P12746 District, P12717 Block,
 *      P12748 Sub-district, P12745 Village (+ P5578 Census 2011 code, which
 *      village-directory.csv also lists), each with a P625 coordinate.
 *   2. Each code is joined to its LGD names from the seed CSVs, and the
 *      output is keyed by lower-cased names ('state|district|block|village')
 *      because registrations store names picked from those same LGD lists.
 *   3. Gaps are filled from real data, not guesses: a Block (or District)
 *      without its own Wikidata point gets the centroid of its villages that
 *      do have one; failing that, a same-named Sub-district in the district;
 *      failing that, the centroid of the Sub-districts its villages belong
 *      to (blocks and sub-districts divide the same district).
 *   4. Sanity check: a village point more than ~1.5° from its district's
 *      point is a Wikidata data-entry error and is dropped.
 *
 * Usage (one-off build step; re-run to refresh, e.g. after re-downloading
 * the LGD snapshot — makes read-only requests to query.wikidata.org):
 *   node scripts/build-place-coords.mjs
 *
 * Coordinates: Wikidata, CC0.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../db/seed-data/lgd')
const OUT_FILE = path.join(DATA_DIR, 'place-coords.json.gz')
const SPARQL = 'https://query.wikidata.org/sparql'
const USER_AGENT = 'FieldFlow-place-coords-builder/1.0 (NGO beneficiary dashboard; one-off static build)'

function readCsvGz(file) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(DATA_DIR, file))).toString('utf8')
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data
}
const clean = v => String(v ?? '').trim()
const low = v => clean(v).toLowerCase()
const round = n => Math.round(n * 1e4) / 1e4

// code -> [lat, lng] for every Wikidata item carrying `prop` and a coordinate.
// Paged by code prefix digit so no single query nears the 60s SPARQL timeout.
async function fetchCoords(prop, label) {
  const out = new Map()
  for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
    const q = `SELECT ?code ?coord WHERE { ?i wdt:${prop} ?code ; wdt:P625 ?coord . FILTER(STRSTARTS(STR(?code), "${digit}")) }`
    let rows
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`${SPARQL}?format=json&query=${encodeURIComponent(q)}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' } })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        rows = (await r.json()).results.bindings
        break
      } catch (e) {
        if (attempt >= 3) throw new Error(`${label} (${digit}*): ${e.message}`)
        await new Promise(res => setTimeout(res, 5000 * attempt))
      }
    }
    for (const b of rows) {
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value) // WKT is "Point(lng lat)"
      if (!m) continue
      const code = String(parseInt(b.code.value, 10))
      if (code === 'NaN' || out.has(code)) continue
      out.set(code, [Number(m[2]), Number(m[1])])
    }
    await new Promise(res => setTimeout(res, 1000)) // be gentle with the public endpoint
  }
  console.log(`  ${label}: ${out.size} coded items with coordinates`)
  return out
}

const centroid = pts => pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : null
const near = (a, b, deg) => Math.abs(a[0] - b[0]) <= deg && Math.abs(a[1] - b[1]) <= deg

async function main() {
  console.log('Reading LGD seed data…')
  const stateName = new Map(readCsvGz('states.csv.gz').map(r => [clean(r['State Code']), clean(r['State Name'])]))
  const districts = readCsvGz('districts.csv.gz').map(r => ({
    code: String(parseInt(r['District Code'], 10)), name: clean(r['District Name']), state: stateName.get(clean(r['State Code'])),
  })).filter(d => d.state && d.name)
  const districtByCode = new Map(districts.map(d => [d.code, d]))
  const blocks = readCsvGz('blocks.csv.gz').map(r => ({
    code: String(parseInt(r['Block Code'], 10)), name: clean(r['Block Name ']) || clean(r['Block Name']),
    districtCode: String(parseInt(r['District Code'], 10)),
  })).filter(b => b.name && districtByCode.has(b.districtCode))
  const villageRows = readCsvGz('village-directory.csv.gz')
  console.log(`  ${districts.length} districts, ${blocks.length} blocks, ${villageRows.length} village rows`)

  console.log('Fetching coordinates from Wikidata…')
  const wdDistrict = await fetchCoords('P12746', 'districts (LGD)')
  const wdBlock    = await fetchCoords('P12717', 'blocks (LGD)')
  const wdSubdist  = await fetchCoords('P12748', 'sub-districts (LGD)')
  const wdVillage  = await fetchCoords('P12745', 'villages (LGD)')
  const wdCensus   = await fetchCoords('P5578',  'census 2011 areas')

  // Villages first — their points also feed block/district centroids.
  const villagePts = new Map()       // key -> [lat, lng]
  const blockVillagePts = new Map()  // block code -> [[lat, lng], ...]
  const districtVillagePts = new Map()
  const subdistNames = new Map()     // district code|subdistrict name -> subdistrict code
  const blockSubdists = new Map()    // block code -> Map<subdistrict code, village count>
  let droppedFar = 0
  for (const r of villageRows) {
    const dCode = String(parseInt(r['District code'], 10))
    const d = districtByCode.get(dCode)
    if (!d) continue
    const sdCode = String(parseInt(r['Subdistrict code'], 10))
    if (clean(r['Subdistrict Name(In English)'])) subdistNames.set(`${dCode}|${low(r['Subdistrict Name(In English)'])}`, sdCode)
    const bc = String(parseInt(r['Block code'], 10))
    if (bc !== 'NaN' && sdCode !== 'NaN') {
      const m = blockSubdists.get(bc) || blockSubdists.set(bc, new Map()).get(bc)
      m.set(sdCode, (m.get(sdCode) || 0) + 1)
    }
    const pt = wdVillage.get(String(parseInt(r['Village code'], 10))) || wdCensus.get(String(parseInt(r['VillageCunsecCode'], 10)))
    if (!pt) continue
    const dPt = wdDistrict.get(dCode)
    if (dPt && !near(pt, dPt, 1.5)) { droppedFar++; continue }
    const bCode = String(parseInt(r['Block code'], 10))
    const key = [d.state, d.name, clean(r['Block Name(In English)']), clean(r['Village Name(In English)'])].map(low).join('|')
    if (!villagePts.has(key)) villagePts.set(key, pt)
    if (bCode !== 'NaN') (blockVillagePts.get(bCode) || blockVillagePts.set(bCode, []).get(bCode)).push(pt)
    ;(districtVillagePts.get(dCode) || districtVillagePts.set(dCode, []).get(dCode)).push(pt)
  }

  const districtOut = {}, blockOut = {}, villageOut = {}
  const stats = { district: { wikidata: 0, centroid: 0, none: 0 }, block: { wikidata: 0, centroid: 0, subdistrict: 0, subdistrictCentroid: 0, none: 0 } }
  // Village-count-weighted centroid of the Sub-districts (tehsils/mandals)
  // a block's villages belong to — blocks and sub-districts are parallel
  // divisions of the same district, so this lands inside/near the block.
  const subdistrictCentroid = blockCode => {
    const pts = []
    for (const [sd, n] of blockSubdists.get(blockCode) || []) {
      const p = wdSubdist.get(sd)
      if (p) for (let i = 0; i < n; i++) pts.push(p)
    }
    return centroid(pts)
  }
  for (const d of districts) {
    const own = wdDistrict.get(d.code)
    const pt = own || centroid(districtVillagePts.get(d.code) || [])
    stats.district[own ? 'wikidata' : pt ? 'centroid' : 'none']++
    if (pt) districtOut[`${low(d.state)}|${low(d.name)}`] = pt.map(round)
  }
  for (const b of blocks) {
    const d = districtByCode.get(b.districtCode)
    const dPt = districtOut[`${low(d.state)}|${low(d.name)}`]
    let pt = wdBlock.get(b.code), src = 'wikidata'
    if (pt && dPt && !near(pt, dPt, 1.5)) pt = null
    if (!pt) { pt = centroid(blockVillagePts.get(b.code) || []); src = 'centroid' }
    if (!pt) { const sd = subdistNames.get(`${b.districtCode}|${low(b.name)}`); pt = sd ? wdSubdist.get(sd) : null; src = 'subdistrict' }
    if (!pt) { pt = subdistrictCentroid(b.code); src = 'subdistrictCentroid' }
    if (pt && dPt && !near(pt, dPt, 1.5)) pt = null
    stats.block[pt ? src : 'none']++
    if (pt) blockOut[`${low(d.state)}|${low(d.name)}|${low(b.name)}`] = pt.map(round)
  }
  for (const [k, pt] of villagePts) villageOut[k] = pt.map(round)

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    source: 'Wikidata (CC0) coordinates joined on LGD codes to db/seed-data/lgd — see scripts/build-place-coords.mjs',
    districts: districtOut, blocks: blockOut, villages: villageOut,
  }
  fs.writeFileSync(OUT_FILE, zlib.gzipSync(JSON.stringify(out), { level: 9 }))
  console.log('\nDistricts:', stats.district, `→ ${Object.keys(districtOut).length}/${districts.length}`)
  console.log('Blocks:   ', stats.block, `→ ${Object.keys(blockOut).length}/${blocks.length}`)
  console.log(`Villages:  ${Object.keys(villageOut).length} (dropped ${droppedFar} implausible points)`)
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB)`)
}

main().catch(e => { console.error('Build failed:', e.message); process.exit(1) })
