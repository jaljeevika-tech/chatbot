// Static India-wide District/Block/Village coordinates from
// scripts/build-place-coords.mjs (Wikidata joined on LGD codes), so the registration
// map needs no runtime geocoding. The file is several MB: loaded lazily, kept in
// memory, and only the needed entries are returned.

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(__dirname, '../db/seed-data/lgd/place-coords.json.gz')

let cache = null
function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8'))
  } catch (e) {
    // Missing/corrupt file → the map falls back to approximate placement.
    console.warn('[placeCoords] could not load', FILE, '—', e.message)
    cache = { districts: {}, blocks: {}, villages: {} }
  }
  return cache
}

const low = v => String(v ?? '').trim().toLowerCase()

/**
 * Known [lat, lng] for every distinct place in `rows`, keyed like the frontend's
 * locationKey() (lower-cased, '|'-joined, missing levels ''). Unknown places are absent.
 */
export function placeCoordsFor(rows) {
  const { districts, blocks, villages } = load()
  const out = {}
  for (const r of rows) {
    const [s, d, b, v] = [low(r.state), low(r.district), low(r.block), low(r.village)]
    if (!s || !d) continue
    const dPt = districts[`${s}|${d}`]
    if (dPt) out[`${s}|${d}||`] = dPt
    if (!b) continue
    const bPt = blocks[`${s}|${d}|${b}`]
    if (bPt) out[`${s}|${d}|${b}|`] = bPt
    if (!v) continue
    const vPt = villages[`${s}|${d}|${b}|${v}`]
    if (vPt) out[`${s}|${d}|${b}|${v}`] = vPt
  }
  return out
}
