// Post-generation editor for a podcast or video script. Each line keeps `origIdx` so the
// caller re-voices only new/changed lines (see unchangedLine()).
import { useState } from 'react'
import { Plus, Trash2, Check, X, ArrowLeftRight } from 'lucide-react'
import type { AudioLine } from '../../types/notebook'
import { unchangedLine, type EditableLine } from './scriptEdits'
export { unchangedLine, type EditableLine }

const C = { dark: '#0E3A46', line: '#D9E6E8', soft: '#86A0A5', bg: '#F2F7F8', alex: '#0E3A46', jordan: '#341272' }

interface Props {
  lines: AudioLine[]
  hostNames: { alex: string; jordan: string }
  /** What a speaker is called in this context ("host" for podcast, "voice" for video). */
  noun?: string
  /** One narrator (video): no speaker switch, and new lines stay with the narrator. */
  singleVoice?: boolean
  onSave: (lines: EditableLine[]) => void
  onCancel: () => void
}

export function ScriptEditor({ lines, hostNames, noun = 'host', singleVoice = false, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<EditableLine[]>(() => lines.map((l, i) => ({ ...l, origIdx: i })))

  const update = (i: number, patch: Partial<EditableLine>) => setDraft(d => d.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const remove = (i: number) => setDraft(d => d.filter((_, j) => j !== i))
  const insertAfter = (i: number) => setDraft(d => {
    // New line goes to the other speaker, like a natural reply (one narrator: same voice).
    const host: AudioLine['host'] = singleVoice ? 'ALEX' : d[i]?.host === 'ALEX' ? 'JORDAN' : 'ALEX'
    return [...d.slice(0, i + 1), { host, text: '' }, ...d.slice(i + 1)]
  })

  const cleaned = draft.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text)
  const changed = cleaned.length !== lines.length || cleaned.some(l => !unchangedLine(lines, l))
  const toVoice = cleaned.filter(l => !unchangedLine(lines, l)).length

  return (
    <div className="flex flex-col gap-2 rounded-2xl p-3" style={{ background: C.bg, border: `1.5px solid ${C.line}` }}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold" style={{ color: C.dark }}>Edit script</p>
        <p className="text-[10px]" style={{ color: C.soft }}>Only new or changed lines are re-voiced</p>
      </div>

      <div className="flex flex-col gap-1.5 max-h-[55vh] overflow-auto pr-1">
        {draft.map((l, i) => {
          const name = l.host === 'ALEX' ? hostNames.alex : hostNames.jordan
          const edited = !unchangedLine(lines, l)
          return (
            <div key={i} className="flex items-start gap-1.5 rounded-xl p-2" style={{ background: '#FFFFFF', borderLeft: `3px solid ${edited ? '#F59E0B' : 'transparent'}` }}>
              {!singleVoice && <button
                onClick={() => update(i, { host: l.host === 'ALEX' ? 'JORDAN' : 'ALEX' })}
                title={`Switch ${noun}`}
                className="shrink-0 flex items-center gap-1 rounded-lg px-1.5 py-1 text-[10px] font-black"
                style={{ color: l.host === 'ALEX' ? C.alex : C.jordan, background: C.bg }}
              >
                {name}<ArrowLeftRight className="w-2.5 h-2.5 opacity-60" />
              </button>}
              <textarea
                value={l.text}
                onChange={e => update(i, { text: e.target.value })}
                rows={Math.min(6, Math.max(2, Math.ceil(l.text.length / 48)))}
                placeholder="Type what this voice says…"
                className="flex-1 min-w-0 text-[11px] leading-relaxed rounded-lg px-2 py-1 resize-y outline-none"
                style={{ background: C.bg, color: '#1F2937', border: `1px solid ${C.line}` }}
              />
              <div className="shrink-0 flex flex-col gap-1">
                <button onClick={() => insertAfter(i)} title="Add a line below" className="p-1 rounded-md hover:bg-gray-100"><Plus className="w-3 h-3" style={{ color: C.soft }} /></button>
                <button onClick={() => remove(i)} title="Delete line" className="p-1 rounded-md hover:bg-red-50"><Trash2 className="w-3 h-3 text-red-400" /></button>
              </div>
            </div>
          )
        })}
        {draft.length === 0 && (
          <button onClick={() => setDraft([{ host: 'ALEX', text: '' }])} className="text-[11px] font-semibold py-2 rounded-xl" style={{ color: C.dark, border: `1.5px dashed ${C.line}` }}>
            + Add a line
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSave(cleaned)}
          disabled={!changed || cleaned.length === 0}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold"
          style={{ background: changed && cleaned.length ? C.dark : C.line, color: changed && cleaned.length ? '#FFFFFF' : C.soft }}
        >
          <Check className="w-3.5 h-3.5" />
          {changed ? `Save & re-voice ${toVoice} line${toVoice === 1 ? '' : 's'}` : 'No changes yet'}
        </button>
        <button onClick={onCancel} className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-xs font-bold" style={{ background: '#FFFFFF', color: C.dark, border: `1.5px solid ${C.line}` }}>
          <X className="w-3.5 h-3.5" />Cancel
        </button>
      </div>
    </div>
  )
}
