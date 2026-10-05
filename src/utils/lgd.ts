// Client for the LGD (Local Government Directory) lookup endpoints (routes/lgd.routes.js).

import { apiFetch } from './apiFetch'

export interface LgdOption {
  code: number
  name: string
}

async function getJson(url: string): Promise<LgdOption[]> {
  const r = await apiFetch(url)
  if (!r.ok) return []
  return r.json()
}

export interface LgdState extends LgdOption { isUt?: boolean }

export const fetchLgdStates = (): Promise<LgdState[]> =>
  getJson('/api/lgd/states')

// No stateCode = every district nationally (763 rows, small enough to fetch in full).
export const fetchLgdDistricts = (stateCode?: number): Promise<LgdOption[]> =>
  getJson(`/api/lgd/districts${stateCode != null ? `?state=${stateCode}` : ''}`)

export const fetchLgdBlocks = (districtCode: number, q = ''): Promise<LgdOption[]> =>
  getJson(`/api/lgd/blocks?district=${districtCode}${q ? `&q=${encodeURIComponent(q)}` : ''}`)

export const fetchLgdPanchayats = (blockCode: number, q = ''): Promise<LgdOption[]> =>
  getJson(`/api/lgd/panchayats?block=${blockCode}${q ? `&q=${encodeURIComponent(q)}` : ''}`)

export const fetchLgdVillages = (
  scope: { panchayatCode?: number; blockCode?: number },
  q = ''
): Promise<LgdOption[]> => {
  const param = scope.panchayatCode != null ? `panchayat=${scope.panchayatCode}` : `block=${scope.blockCode}`
  return getJson(`/api/lgd/villages?${param}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
}
