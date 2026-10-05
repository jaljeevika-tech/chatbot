// Hand-maintained District/Block HQ coordinates for the beneficiary location map
// (registrations carry only names/codes). Source: Wikipedia/Wikidata P625, 2026-09-26.
// Only verified entries; unlisted places are drawn in a ring around their parent as
// "approximate". Key = lower-cased names joined with '|', exactly as registered.

export type LatLng = [number, number]

// key: 'state|district'
export const DISTRICT_COORDS: Record<string, LatLng> = {
  'andhra pradesh|west godavari':        [16.5430, 81.5230], // HQ Bhimavaram (since the 2022 reorganisation; Eluru before)
  'bihar|khagaria':                      [25.5083, 86.4742],
  'bihar|purnia':                        [25.7780, 87.4760],
  'bihar|supaul':                        [26.1260, 86.6050],
  'maharashtra|gadchiroli':              [20.1850, 79.9840],
  'telangana|adilabad':                  [19.6700, 78.5300],
  'telangana|kumuram bheem asifabad':    [19.3650, 79.2740], // HQ Asifabad
  'telangana|mancherial':                [18.8714, 79.4443],
  'telangana|peddapalli':                [18.6101, 79.3794],
}

// Alternate district spellings seen in data entry → canonical key above.
export const DISTRICT_ALIASES: Record<string, string> = {
  'telangana|komaram bheem asifabad': 'telangana|kumuram bheem asifabad',
  'telangana|kumram bheem asifabad':  'telangana|kumuram bheem asifabad',
  'telangana|komaram bheem':          'telangana|kumuram bheem asifabad',
  'telangana|asifabad':               'telangana|kumuram bheem asifabad',
  'bihar|purnea':                     'bihar|purnia',
}

// key: 'state|district|block'
export const BLOCK_COORDS: Record<string, LatLng> = {
  'andhra pradesh|west godavari|iragavaram':        [16.6920, 81.7070],
  'bihar|khagaria|alauli':                          [25.5000, 86.4800],
  'bihar|khagaria|khagaria':                        [25.5083, 86.4742],
  'maharashtra|gadchiroli|etapalli':                [19.6000, 80.2300],
  'telangana|adilabad|aidilabad rural':             [19.6700, 78.5300], // Adilabad Rural mandal surrounds Adilabad town
  'telangana|adilabad|adilabad rural':              [19.6700, 78.5300],
  'telangana|kumuram bheem asifabad|asifabad':      [19.3650, 79.2740],
  'telangana|kumuram bheem asifabad|kagaznagar':    [19.3333, 79.4833],
  'telangana|kumuram bheem asifabad|kerameri':      [19.4333, 79.0500],
  'telangana|kumuram bheem asifabad|sirpur (t)':    [19.4833, 79.6000],
  'telangana|mancherial|jaipur':                    [18.8490, 79.5755],
  'telangana|mancherial|kasipet':                   [19.0333, 79.4667],
  'telangana|mancherial|mancherial':                [18.8714, 79.4443],
  'telangana|peddapalli|peddapalli':                [18.6101, 79.3794],
}

const norm = (v: string | null | undefined) => (v || '').trim().toLowerCase()

function canonicalDistrictKey(state: string, district: string): string {
  const key = `${norm(state)}|${norm(district)}`
  return DISTRICT_ALIASES[key] || key
}

export function resolveDistrictCoords(state: string, district: string): LatLng | null {
  return DISTRICT_COORDS[canonicalDistrictKey(state, district)] || null
}

export function resolveBlockCoords(state: string, district: string, block: string): LatLng | null {
  return BLOCK_COORDS[`${canonicalDistrictKey(state, district)}|${norm(block)}`] || null
}
