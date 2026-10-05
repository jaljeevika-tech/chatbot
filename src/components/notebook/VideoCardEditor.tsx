// Post-generation editor for the Video Overview's on-screen cards (the key
// point shown with each picture). Text only — pictures, timing and narration
// are untouched, so saving needs no re-generation.
import { useState } from 'react'
import { Check, X } from 'lucide-react'
import type { VideoSlide } from '../../types/notebook'

const C = { dark: '#0E3A46', line: '#E5E7EB', soft: '#9CA3AF', bg: '#F9FAFB' }
const KIND_LABEL: Record<VideoSlide['visual'], string> = { list: 'Key points', stat: 'Big number', quote: 'Quote' }

interface Props {
  slides: VideoSlide[]
  onSave: (slides: VideoSlide[]) => void
  onCancel: () => void
}

function Field({ label, value, onChange, rows = 1, placeholder }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  const cls = 'w-full text-[11px] rounded-lg px-2 py-1 outline-none'
  const style = { background: '#FFFFFF', color: '#1F2937', border: `1px solid ${C.line}` }
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: C.soft }}>{label}</span>
      {rows > 1
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder} className={`${cls} resize-y leading-snug`} style={style} />
        : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={cls} style={style} />}
    </label>
  )
}

export function VideoCardEditor({ slides, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<VideoSlide[]>(() => slides.map(s => ({ ...s, bullets: s.bullets ? [...s.bullets] : s.bullets, stat: s.stat ? { ...s.stat } : s.stat })))
  const set = (i: number, patch: Partial<VideoSlide>) => setDraft(d => d.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const save = () => onSave(draft.map(s => ({
    ...s,
    title: s.title.trim(),
    bullets: s.bullets?.map(b => b.trim()).filter(Boolean),
    stat: s.stat ? { value: s.stat.value.trim(), label: s.stat.label.trim() } : s.stat,
    quote: s.quote?.trim(),
    quoteAttribution: s.quoteAttribution?.trim(),
    location: s.location?.trim() || undefined,
    date: s.date?.trim() || undefined,
  })))
  const valid = draft.every(s => s.title.trim())

  return (
    <div className="flex flex-col gap-2 rounded-2xl p-3" style={{ background: C.bg, border: `1.5px solid ${C.line}` }}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold" style={{ color: C.dark }}>Edit on-screen text</p>
        <p className="text-[10px]" style={{ color: C.soft }}>Pictures and voices stay as they are</p>
      </div>
      <div className="flex flex-col gap-2 max-h-[55vh] overflow-auto pr-1">
        {draft.map((s, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-xl p-2.5" style={{ background: '#FFFFFF', border: `1px solid ${C.line}` }}>
            <p className="text-[10px] font-black" style={{ color: C.dark }}>Card {i + 1} · {KIND_LABEL[s.visual]}</p>
            <Field label="Title" value={s.title} onChange={v => set(i, { title: v })} />
            {s.visual === 'list' && (
              <Field label="Points — one per line" rows={3} value={(s.bullets || []).join('\n')}
                onChange={v => set(i, { bullets: v.split('\n') })} />
            )}
            {s.visual === 'stat' && (
              <div className="flex gap-2">
                <div className="w-1/3"><Field label="Number" value={s.stat?.value ?? ''} onChange={v => set(i, { stat: { value: v, label: s.stat?.label ?? '' } })} /></div>
                <div className="flex-1"><Field label="What it counts" value={s.stat?.label ?? ''} onChange={v => set(i, { stat: { value: s.stat?.value ?? '', label: v } })} /></div>
              </div>
            )}
            {s.visual === 'quote' && (<>
              <Field label="Quote (keep it word-for-word from the source)" rows={2} value={s.quote ?? ''} onChange={v => set(i, { quote: v })} />
              <Field label="Who / where it's from" value={s.quoteAttribution ?? ''} onChange={v => set(i, { quoteAttribution: v })} />
            </>)}
            <div className="flex gap-2">
              <div className="flex-1"><Field label="Place" value={s.location ?? ''} onChange={v => set(i, { location: v })} /></div>
              <div className="flex-1"><Field label="Date" value={s.date ?? ''} onChange={v => set(i, { date: v })} /></div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={save} disabled={!valid}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold"
          style={{ background: valid ? C.dark : C.line, color: valid ? '#FFFFFF' : C.soft }}>
          <Check className="w-3.5 h-3.5" />Save text
        </button>
        <button onClick={onCancel} className="flex items-center justify-center gap-1 px-3 py-2 rounded-xl text-xs font-bold"
          style={{ background: '#FFFFFF', color: C.dark, border: `1.5px solid ${C.line}` }}>
          <X className="w-3.5 h-3.5" />Cancel
        </button>
      </div>
    </div>
  )
}
