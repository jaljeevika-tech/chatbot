// lib/misUpsertHelpers.js — new / updated / duplicate upsert for the beneficiary-linked
// MIS bulk uploads (Training and its six siblings). Same rule as misImportSchemas'
// identityKeyFor: a row is a duplicate only if every content column matches the row at
// its identity key; any difference makes it an update. Audit columns are never compared.

function normForCompare(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return v
  const s = String(v).trim()
  return s === '' ? null : s.toLowerCase()
}

function valuesEqual(a, b) {
  const na = normForCompare(a)
  const nb = normForCompare(b)
  if (na === null && nb === null) return true
  if (na === null || nb === null) return false
  if (typeof na === 'number' || typeof nb === 'number') return Number(na) === Number(nb)
  return na === nb
}

// Sheet date → 'YYYY-MM-DD'. Accepts ISO (YYYY-MM-DD...) or Indian
// DD/MM/YYYY (also - or . separators). Never falls back to new Date(),
// which reads 05/01/2026 as 1 May. Returns { date } or { error }.
export function parseMisDate(v) {
  const s = String(v ?? '').trim()
  if (!s) return { date: null }
  let y, m, d, hit
  if ((hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T ])/))) [, y, m, d] = hit
  else if ((hit = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = hit
  else return { error: `Unrecognised date "${s}" — use DD/MM/YYYY or YYYY-MM-DD` }
  const dt = new Date(Date.UTC(+y, +m - 1, +d))
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) {
    return { error: `Invalid date "${s}"` }
  }
  return { date: dt.toISOString().slice(0, 10) }
}

// identity: { column: value } — the ON CONFLICT / unique-index key.
// content:  { column: value } — the fields compared to decide duplicate vs
//           updated vs new, and written on both insert and update.
// audit:    { column: value } — written on both insert and update, never
//           compared (e.g. uploaded_by).
// Returns 'new' | 'updated' | 'duplicate'.
export async function upsertMisRow(pool, { table, identity, content, audit = {} }) {
  const idCols   = Object.keys(identity)
  const idVals   = Object.values(identity)
  const contentCols = Object.keys(content)

  // IS NOT DISTINCT FROM: plain `=` never matches NULL, so a blank date would never match.
  const { rows: [existing] } = await pool.query(
    `SELECT ${contentCols.join(', ')} FROM ${table}
     WHERE ${idCols.map((c, i) => `${c} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}`,
    idVals
  )

  const auditCols = Object.keys(audit)
  const allCols = [...idCols, ...contentCols, ...auditCols]
  const allVals = [...idVals, ...Object.values(content), ...Object.values(audit)]

  if (!existing) {
    await pool.query(
      `INSERT INTO ${table} (${allCols.join(', ')})
       VALUES (${allCols.map((_, i) => `$${i + 1}`).join(', ')})`,
      allVals
    )
    return 'new'
  }

  const unchanged = contentCols.every(c => valuesEqual(existing[c], content[c]))
  if (unchanged) return 'duplicate'

  const setCols = [...contentCols, ...auditCols]
  const setVals = [...Object.values(content), ...Object.values(audit)]
  await pool.query(
    `UPDATE ${table} SET ${setCols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
     WHERE ${idCols.map((c, i) => `${c} IS NOT DISTINCT FROM $${setVals.length + i + 1}`).join(' AND ')}`,
    [...setVals, ...idVals]
  )
  return 'updated'
}
