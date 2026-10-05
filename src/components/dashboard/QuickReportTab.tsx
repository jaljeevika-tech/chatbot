// Mobile-first daily report entry: staff dictate or type, Gemini extracts fields,
// the user reviews and confirms, and the row lands in daily_reports.

import { useState, useEffect, useRef } from 'react'
import {
  Mic, MicOff, Sparkles, Send, Loader2, AlertCircle,
  CheckCircle2, RefreshCw,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { useOrg } from '../../context/OrgContext'

const C = {
  purple: '#341272',
  purpleLight: '#9333ea',
  green: '#3F7D5C',   // FF.green
  amber: '#B8862E',   // FF.amber
  red: '#B0473C',     // FF.red
  border: '#D9E6E8',  // FF.border
  surface: '#FBF9F4', // FF.bgWarm
}

type ExtractedFields = {
  location:             string | null
  state:                string | null
  project:              string | null
  area_of_intervention: string | null
  beneficiaries:        number | null
  description:          string
}

// Browser-native Web Speech API; degrades gracefully where unsupported.
function useSpeechRecognition(lang = 'hi-IN') {
  const recRef = useRef<any>(null)
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)

  useEffect(() => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setSupported(false); return }
    setSupported(true)
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang
    recRef.current = rec
    return () => { try { rec.stop() } catch {} }
  }, [lang])

  return {
    supported,
    listening,
    start: (onTranscript: (text: string, isFinal: boolean) => void) => {
      const rec = recRef.current
      if (!rec) return
      rec.onresult = (e: any) => {
        let txt = ''
        let isFinal = false
        for (let i = e.resultIndex; i < e.results.length; i++) {
          txt += e.results[i][0].transcript
          if (e.results[i].isFinal) isFinal = true
        }
        onTranscript(txt, isFinal)
      }
      rec.onerror = () => setListening(false)
      rec.onend   = () => setListening(false)
      try { rec.start(); setListening(true) } catch {}
    },
    stop: () => { try { recRef.current?.stop() } catch {}; setListening(false) },
  }
}

export function QuickReportTab() {
  const { org } = useOrg()
  // Project labels for the autocomplete hint.
  const projectsHint: string[] = ((org as any)?.projects || []).map((p: any) => p?.label).filter(Boolean)

  // Unsaved text is restored on mount and cleared on successful submit
  const DRAFT_KEY = 'quickReport.draft.text'
  const [text, setText] = useState<string>(() => {
    try { return localStorage.getItem(DRAFT_KEY) || '' } catch { return '' }
  })
  useEffect(() => {
    const h = setTimeout(() => {
      try {
        if (text.trim()) localStorage.setItem(DRAFT_KEY, text)
        else             localStorage.removeItem(DRAFT_KEY)
      } catch {}
    }, 1000)
    return () => clearTimeout(h)
  }, [text])
  const [extracting, setExtracting]   = useState(false)
  const [submitting, setSubmitting]   = useState(false)
  const [fields, setFields]     = useState<ExtractedFields | null>(null)
  const [confidence, setConfidence] = useState<number>(0)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState<string | null>(null)
  const [lang, setLang]         = useState('hi-IN')

  const speech = useSpeechRecognition(lang)
  const interimRef = useRef('')

  function handleMic() {
    if (speech.listening) {
      speech.stop()
      return
    }
    interimRef.current = text
    speech.start((transcript, isFinal) => {
      if (isFinal) {
        setText(t => (t + ' ' + transcript).trim())
        interimRef.current = ''
      }
    })
  }

  async function handleExtract() {
    if (!text.trim() || extracting) return
    setExtracting(true); setError(''); setFields(null)
    try {
      const r = await apiFetch('/api/reports/quick-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), projectsHint }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Extraction failed'); setExtracting(false); return }
      setFields(d.fields)
      setConfidence(d.confidence || 0)
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setExtracting(false)
  }

  async function handleSubmit() {
    if (!fields || submitting) return
    setSubmitting(true); setError('')
    try {
      const r = await apiFetch('/api/reports/quick-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields,
          original_text: text.trim(),
          // No photo picker until field staff have an upload endpoint (project media is editor-only).
          photo_urls: [],
        }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Save failed'); setSubmitting(false); return }
      // Reset immediately so nothing typed after submit is wiped; only the banner lingers.
      setText(''); setFields(null); setConfidence(0); setSuccess(d.id)
      try { localStorage.removeItem(DRAFT_KEY) } catch {}
      setTimeout(() => setSuccess(s => (s === d.id ? null : s)), 2500)
    } catch (e: any) {
      setError(e.message || 'Network error')
    }
    setSubmitting(false)
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <h2 className="text-xl font-bold" style={{ color: C.purple }}>Quick Report</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Tell us about your day — type or speak. AI extracts the fields for you.
        </p>
      </div>

      <div className="bg-white rounded-2xl border p-4 space-y-3" style={{ borderColor: C.border }}>
        <div className="flex items-center justify-between gap-2">
          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">What happened today?</label>
          {speech.supported && (
            <div className="flex items-center gap-1">
              <select
                value={lang}
                onChange={e => setLang(e.target.value)}
                disabled={speech.listening}
                className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-500 focus:outline-none"
              >
                <option value="hi-IN">हिन्दी</option>
                <option value="en-IN">English (IN)</option>
                <option value="mr-IN">मराठी</option>
                <option value="ta-IN">தமிழ்</option>
                <option value="bn-IN">বাংলা</option>
              </select>
            </div>
          )}
        </div>

        <textarea
          className="w-full rounded-xl border border-gray-200 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
          rows={5}
          placeholder="e.g. आज मैं खगड़िया गया, 30 किसानों से मिला, पेन कल्चर पर प्रशिक्षण दिया …"
          value={text}
          onChange={e => setText(e.target.value)}
          disabled={extracting || submitting}
        />

        <div className="flex items-center gap-2 flex-wrap">
          {speech.supported ? (
            <button
              type="button"
              onClick={handleMic}
              disabled={extracting || submitting}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition border disabled:opacity-50"
              style={{
                background: speech.listening ? C.red : 'white',
                color:      speech.listening ? '#fff' : C.purple,
                borderColor: speech.listening ? C.red : C.border,
              }}
            >
              {speech.listening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              {speech.listening ? 'Stop' : 'Speak'}
            </button>
          ) : (
            <span className="text-[10px] text-gray-400 px-2">🎙 Voice not supported in this browser</span>
          )}

          <div className="flex-1" />

          <button
            onClick={handleExtract}
            disabled={!text.trim() || extracting || submitting}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #9333ea 0%, #341272 100%)' }}
          >
            {extracting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {extracting ? 'Extracting…' : 'Extract Fields'}
          </button>
        </div>

        {speech.listening && (
          <p className="text-[10px] text-red-600 flex items-center gap-1 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-red-600" /> Listening… speak naturally
          </p>
        )}
      </div>

      {fields && (
        <div className="bg-white rounded-2xl border p-4 space-y-3" style={{ borderColor: C.border }}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-800 text-sm">Review what AI extracted</h3>
              <p className="text-[10px] text-gray-400">Edit any field below before saving</p>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-gray-400">Confidence</div>
              <div className="text-sm font-bold" style={{ color: confidence >= 0.7 ? C.green : confidence >= 0.4 ? C.amber : C.red }}>
                {Math.round(confidence * 100)}%
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Location" value={fields.location || ''} onChange={v => setFields(f => f ? { ...f, location: v } : f)} placeholder="Village or district" />
            <Field label="State"    value={fields.state || ''}    onChange={v => setFields(f => f ? { ...f, state: v } : f)} placeholder="Bihar" />
            <Field label="Project"  value={fields.project || ''}  onChange={v => setFields(f => f ? { ...f, project: v } : f)} placeholder="Kosi Sahjivan" list={projectsHint} />
            <Field label="Area of Intervention" value={fields.area_of_intervention || ''} onChange={v => setFields(f => f ? { ...f, area_of_intervention: v } : f)} placeholder="Training, awareness, livelihood…" />
            <Field
              label="Beneficiaries"
              value={fields.beneficiaries != null ? String(fields.beneficiaries) : ''}
              onChange={v => setFields(f => f ? { ...f, beneficiaries: v.trim() === '' ? null : (parseInt(v) || null) } : f)}
              placeholder="30"
              type="number"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Description</label>
            <textarea
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
              rows={3}
              value={fields.description}
              onChange={e => setFields(f => f ? { ...f, description: e.target.value } : f)}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setFields(null); setConfidence(0) }}
              disabled={submitting}
              className="px-4 py-2 rounded-xl text-xs font-semibold border border-gray-200 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Re-extract
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="px-5 py-2 rounded-xl text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: C.green }}
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {submitting ? 'Saving…' : 'Save Report'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-xl px-4 py-3">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 text-green-700 text-sm bg-green-50 rounded-xl px-4 py-3 border border-green-200">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> Report saved successfully. Ready for the next one.
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', list }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'number'
  list?: string[]
}) {
  const dataListId = list && list.length > 0 ? `dl-${label.replace(/\W/g, '_')}` : undefined
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">{label}</label>
      <input
        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        list={dataListId}
      />
      {dataListId && (
        <datalist id={dataListId}>
          {list!.map(o => <option key={o} value={o} />)}
        </datalist>
      )}
    </div>
  )
}
