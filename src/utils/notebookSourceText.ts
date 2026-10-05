// Flattens a JSON API response into indented plain text for an Ask AI notebook source.
// Generic on purpose, so every field the endpoint returns shows up rather than only hardcoded keys.

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return value.toLocaleString('en-IN')
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return ''
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One row of a table-like array of objects, rendered as a single compact line. */
function flattenRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && !isPlainObject(v) && !Array.isArray(v))
    .map(([k, v]) => `${k}: ${formatValue(v)}`)
    .join(' | ')
}

function walk(data: unknown, indent: string, lines: string[]) {
  if (Array.isArray(data)) {
    if (data.length === 0) { lines.push(`${indent}(none)`); return }
    for (const item of data) {
      if (isPlainObject(item)) {
        lines.push(`${indent}- ${flattenRow(item)}`)
        // Nested arrays/objects get their own indented block
        for (const [k, v] of Object.entries(item)) {
          if (isPlainObject(v) || Array.isArray(v)) {
            lines.push(`${indent}  ${k}:`)
            walk(v, indent + '    ', lines)
          }
        }
      } else {
        lines.push(`${indent}- ${formatValue(item)}`)
      }
    }
    return
  }
  if (isPlainObject(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (isPlainObject(v)) {
        lines.push(`${indent}${k}:`)
        walk(v, indent + '  ', lines)
      } else if (Array.isArray(v)) {
        lines.push(`${indent}${k} (${v.length}):`)
        walk(v, indent + '  ', lines)
      } else {
        lines.push(`${indent}${k}: ${formatValue(v)}`)
      }
    }
    return
  }
  lines.push(`${indent}${formatValue(data)}`)
}

/** Flattens any JSON-shaped API response into readable text, capped at maxChars. */
export function jsonToReadableText(label: string, data: unknown, maxChars = 30_000): string {
  const lines: string[] = [label, '']
  walk(data, '', lines)
  return lines.join('\n').slice(0, maxChars)
}
