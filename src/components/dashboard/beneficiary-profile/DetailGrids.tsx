import { FF } from '../../../theme/colors'
import { HIDDEN_FIELDS, READONLY_DETAIL_FIELDS, FIELD_OPTIONS, humanizeKey, formatFieldValue } from './helpers'

export function DetailGrid({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record).filter(([k]) => !HIDDEN_FIELDS.has(k))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px 20px' }}>
      {entries.map(([key, value]) => (
        <div key={key}>
          <div style={{ fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: FF.textFaint }}>{humanizeKey(key)}</div>
          <div style={{ fontSize: 13.5, color: FF.tealDark, fontWeight: 500, marginTop: 3, wordBreak: 'break-word' }}>
            {formatFieldValue(key, value)}
          </div>
        </div>
      ))}
    </div>
  )
}

const editableFieldLabelStyle = { fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase' as const, color: FF.textFaint }
const editableFieldInputStyle = {
  width: '100%', marginTop: 3, fontSize: 13.5, color: FF.tealDark, fontWeight: 500,
  padding: '5px 8px', borderRadius: 6, border: `1px solid ${FF.borderSoft}`, background: '#fff',
  fontFamily: "'IBM Plex Sans',sans-serif", boxSizing: 'border-box' as const,
}

// Edit-mode twin of DetailGrid (admins only). Booleans get a Yes/No select so
// a typo can't coerce a bool column to a string server-side.
export function EditableDetailGrid({ record, draft, onChange }: {
  record: Record<string, unknown>
  draft: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}) {
  const entries = Object.entries(record).filter(([k]) => !HIDDEN_FIELDS.has(k))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px 20px' }}>
      {entries.map(([key, value]) => {
        if (READONLY_DETAIL_FIELDS.has(key)) {
          return (
            <div key={key}>
              <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
              <div style={{ fontSize: 13.5, color: FF.tealDark, fontWeight: 500, marginTop: 3, wordBreak: 'break-word' }}>
                {formatFieldValue(key, value)}
              </div>
            </div>
          )
        }
        const current = draft[key]
        if (FIELD_OPTIONS[key]) {
          return (
            <div key={key}>
              <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
              <select
                value={(current ?? '') as string}
                onChange={e => onChange(key, e.target.value === '' ? null : e.target.value)}
                style={editableFieldInputStyle}
              >
                <option value="">—</option>
                {FIELD_OPTIONS[key].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          )
        }
        if (typeof value === 'boolean') {
          return (
            <div key={key}>
              <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
              <select
                value={current === true ? 'true' : current === false ? 'false' : ''}
                onChange={e => onChange(key, e.target.value === '' ? null : e.target.value === 'true')}
                style={editableFieldInputStyle}
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          )
        }
        const isNumber = typeof value === 'number'
        return (
          <div key={key}>
            <div style={editableFieldLabelStyle}>{humanizeKey(key)}</div>
            <input
              type={isNumber ? 'number' : 'text'}
              value={(current ?? '') as string | number}
              onChange={e => onChange(key, isNumber ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
              style={editableFieldInputStyle}
            />
          </div>
        )
      })}
    </div>
  )
}
