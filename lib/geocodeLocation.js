// Place name → lat/long via OpenStreetMap Nominatim. Its usage policy allows
// 1 req/sec with a descriptive User-Agent; this issues one request per call, so
// callers throttle their own loops. Results are cached in location_geocodes (071)
// so each place is looked up once.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'FieldFlow/1.0 (+https://jaljeevika.org; contact: ayush.chopra@jaljeevika.org)'

// Must match the location_key generated column in 071_location_geocodes.sql.
// Panchayat is left out: Nominatim rarely resolves it, and Village is specific enough.
export function locationKey({ state, district, block, village }) {
  return [state, district, block, village].map(v => (v || '').trim().toLowerCase()).join('|')
}

// { latitude, longitude }, or null when there's no match; throws on network/HTTP errors.
export async function geocodePlace({ state, district, block, village }) {
  const query = [village, block, district, state, 'India'].filter(Boolean).join(', ')
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!r.ok) throw new Error(`Nominatim responded ${r.status}`)
  const results = await r.json()
  if (!results.length) return null
  const lat = parseFloat(results[0].lat)
  const lon = parseFloat(results[0].lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { latitude: lat, longitude: lon }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
