// Options for the LGD location questions (appearance lgd-state … lgd-village), same
// behaviour as the registration services' forms: names are stored; codes are only
// looked up to scope the next level. State/district are dropdowns, block/panchayat/
// village are typeahead suggestions over free text. Offline → plain text (null).

import { fetchLgdBlocks, fetchLgdDistricts, fetchLgdPanchayats, fetchLgdStates, fetchLgdVillages, type LgdOption } from '../../utils/lgd'

export type LgdLevel = 'state' | 'district' | 'block' | 'panchayat' | 'village'
type Answers = Record<string, unknown>

const memo = new Map<string, Promise<LgdOption[]>>()
const cached = (key: string, load: () => Promise<LgdOption[]>) => {
  if (!memo.has(key)) memo.set(key, load().then(list => { if (!list.length) memo.delete(key); return list }))
  return memo.get(key)!
}
const name = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const codeOf = (list: LgdOption[], v: unknown) => list.find(o => o.name.toLowerCase() === name(v))?.code

async function stateCode(a: Answers) { return codeOf(await cached('s', fetchLgdStates), a.state) }
async function districtCode(a: Answers) {
  const s = await stateCode(a)
  return s == null ? undefined : codeOf(await cached(`d${s}`, () => fetchLgdDistricts(s)), a.district)
}
async function blockCode(a: Answers) {
  const d = await districtCode(a)
  return d == null || !name(a.block) ? undefined : codeOf(await fetchLgdBlocks(d, String(a.block).trim()), a.block)
}
async function panchayatCode(a: Answers) {
  const b = await blockCode(a)
  return b == null || !name(a.panchayat) ? undefined : codeOf(await fetchLgdPanchayats(b, String(a.panchayat).trim()), a.panchayat)
}

/**
 * Options for one level given the sibling answers and what's typed so far.
 * Returns null when there's nothing to scope by (or the lookup failed) — render free text.
 */
export async function lgdOptions(level: LgdLevel, a: Answers, typed: string): Promise<string[] | null> {
  try {
    let list: LgdOption[] = []
    if (level === 'state') list = await cached('s', fetchLgdStates)
    else if (level === 'district') { const s = await stateCode(a); if (s == null) return null; list = await cached(`d${s}`, () => fetchLgdDistricts(s)) }
    else if (level === 'block') { const d = await districtCode(a); if (d == null) return null; list = await fetchLgdBlocks(d, typed) }
    else if (level === 'panchayat') { const b = await blockCode(a); if (b == null) return null; list = await fetchLgdPanchayats(b, typed) }
    else {
      const p = await panchayatCode(a)
      const b = p == null ? await blockCode(a) : undefined
      if (p == null && b == null) return null
      list = await fetchLgdVillages(p != null ? { panchayatCode: p } : { blockCode: b }, typed)
    }
    return list.length ? list.map(o => o.name) : null
  } catch {
    return null
  }
}
