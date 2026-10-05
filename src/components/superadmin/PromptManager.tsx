// Per-org AI prompt overrides (admin + superadmin): the 14 built-in prompts, each editable inline.

import { useState, useEffect, useRef } from 'react'
import {
  ChevronDown, ChevronUp, RotateCcw, Save,
  Sparkles, Check, AlertCircle, Pencil, X, Info,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'

interface Prompt {
  id:           string
  feature:      string
  type:         string
  description:  string
  defaultText:  string
  customText:   string | null
  status:       string          // 'default' | 'active' | 'testing' | 'disabled'
  notes:        string
  updatedAt:    string | null
  updatedBy:    string | null
  isCustomised: boolean
}

const C = {
  bg:      '#f8f9fb',
  white:   '#ffffff',
  border:  '#e5e7eb',
  text:    '#111827',
  muted:   '#6b7280',
  light:   '#f3f4f6',
  purple:  '#7c3aed',
  purpleL: '#ede9fe',
  teal:    '#0d9488',
  tealL:   '#ccfbf1',
  amber:   '#d97706',
  amberL:  '#fef3c7',
  red:     '#dc2626',
  redL:    '#fee2e2',
  green:   '#16a34a',
  greenL:  '#dcfce7',
  blue:    '#2563eb',
  blueL:   '#dbeafe',
}

const FEATURE_COLORS: Record<string, { bg: string; text: string }> = {
  'Field Report':               { bg: C.blueL,    text: C.blue    },
  'Social Post':                { bg: C.amberL,   text: C.amber   },
  'RW Learn (Voice Profile)':   { bg: C.purpleL,  text: C.purple  },
  'RW Draft':                   { bg: C.greenL,   text: C.green   },
  'RW Refine':                  { bg: '#fce7f3',  text: '#be185d' },
  'RW Reflect':                 { bg: '#fef9c3',  text: '#854d0e' },
  'RW Auto-Polish':             { bg: C.tealL,    text: C.teal    },
  'Notebook Chat':              { bg: '#e0f2fe',  text: '#0369a1' },
  'Notebook Audio Overview':    { bg: '#fdf4ff',  text: '#7e22ce' },
  'Notebook Study Guide':       { bg: '#f0fdf4',  text: '#166534' },
  'Notebook Slide Deck':        { bg: '#fff7ed',  text: '#c2410c' },
  'Notebook Slide Revise':      { bg: '#fef2f2',  text: '#991b1b' },
  'Content Hub':                { bg: '#f0fdf4',  text: '#15803d' },
}

function Badge({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: bg, color, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function PromptRow({
  prompt,
  onSave,
  onReset,
}: {
  prompt:  Prompt
  onSave:  (id: string, text: string, notes: string) => Promise<void>
  onReset: (id: string) => Promise<void>
}) {
  const [open,    setOpen]    = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(prompt.customText ?? prompt.defaultText)
  const [notes,   setNotes]   = useState(prompt.notes)
  const [saving,  setSaving]  = useState(false)
  const [resetting, setResetting] = useState(false)
  const [saved,   setSaved]   = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Sync with parent refreshes, but never overwrite in-progress edits
  useEffect(() => {
    if (!editing) {
      setDraft(prompt.customText ?? prompt.defaultText)
      setNotes(prompt.notes)
    }
  }, [prompt.customText, prompt.notes, editing])

  const fc   = FEATURE_COLORS[prompt.feature] ?? { bg: C.light, text: C.muted }
  const isModified = draft !== (prompt.customText ?? prompt.defaultText) || notes !== prompt.notes

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(prompt.id, draft, notes)
      setEditing(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    if (!confirm('Reset to system default? Your customisation will be deleted.')) return
    setResetting(true)
    try {
      await onReset(prompt.id)
      setDraft(prompt.defaultText)
      setNotes('')
      setEditing(false)
    } finally {
      setResetting(false)
    }
  }

  function handleEdit() {
    setEditing(true)
    setOpen(true)
    setTimeout(() => textareaRef.current?.focus(), 50)
  }

  function handleCancel() {
    setDraft(prompt.customText ?? prompt.defaultText)
    setNotes(prompt.notes)
    setEditing(false)
  }

  return (
    <div style={{
      border: `1px solid ${prompt.isCustomised ? '#a5b4fc' : C.border}`,
      borderRadius: 12,
      background: C.white,
      marginBottom: 8,
      transition: 'box-shadow 0.15s',
      boxShadow: open ? '0 2px 8px rgba(0,0,0,0.06)' : 'none',
    }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
        onClick={() => !editing && setOpen(o => !o)}>

        <div style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: prompt.isCustomised ? C.purple : C.border,
          boxShadow: prompt.isCustomised ? `0 0 0 2px #ede9fe` : 'none',
        }} title={prompt.isCustomised ? 'Customised for your org' : 'Using system default'} />

        <Badge label={prompt.feature} bg={fc.bg} color={fc.text} />
        <Badge label={prompt.type === 'system_instruction' ? 'System' : 'User'} bg={C.light} color={C.muted} />

        <span style={{ fontSize: 12, color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {prompt.description}
        </span>

        {saved && <span style={{ color: C.green, fontSize: 12, display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}><Check size={13} /> Saved</span>}

        {!editing && (
          <button onClick={e => { e.stopPropagation(); handleEdit() }}
            title="Edit this prompt"
            style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, padding: '3px 9px', cursor: 'pointer', color: C.muted, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <Pencil size={11} /> Edit
          </button>
        )}

        {prompt.isCustomised && !editing && (
          <button onClick={e => { e.stopPropagation(); handleReset() }}
            disabled={resetting}
            title="Reset to system default"
            style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 7, padding: '3px 9px', cursor: 'pointer', color: C.red, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, opacity: resetting ? 0.5 : 1 }}>
            <RotateCcw size={11} /> Reset
          </button>
        )}

        {open ? <ChevronUp size={14} color={C.muted} style={{ flexShrink: 0 }} /> : <ChevronDown size={14} color={C.muted} style={{ flexShrink: 0 }} />}
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '14px 16px' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12, color: C.muted }}>
            <Info size={12} />
            <span>
              {prompt.isCustomised
                ? `Custom — last edited ${prompt.updatedAt ? new Date(prompt.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}`
                : 'Using system default — click Edit to customise for your organisation'}
            </span>
            {prompt.isCustomised && (
              <button onClick={() => { setDraft(prompt.defaultText); if (!editing) setEditing(true) }}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: C.blue, fontSize: 12, textDecoration: 'underline' }}>
                View default
              </button>
            )}
          </div>

          <textarea
            ref={textareaRef}
            value={editing ? draft : (prompt.customText ?? prompt.defaultText)}
            onChange={e => setDraft(e.target.value)}
            readOnly={!editing}
            rows={Math.min(Math.max((editing ? draft : (prompt.customText ?? prompt.defaultText)).split('\n').length + 2, 6), 20)}
            style={{
              width: '100%', boxSizing: 'border-box',
              fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6,
              padding: '10px 12px', borderRadius: 8,
              border: `1px solid ${editing ? C.purple : C.border}`,
              background: editing ? C.white : C.bg,
              color: C.text, resize: 'vertical', outline: 'none',
              boxShadow: editing ? `0 0 0 3px #ede9fe` : 'none',
            }}
          />

          {editing && (
            <>
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 4 }}>
                  Change notes (optional — describe what you changed and why)
                </label>
                <input
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. Added our project name to system context"
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    fontFamily: 'inherit', fontSize: 12, padding: '7px 10px',
                    borderRadius: 8, border: `1px solid ${C.border}`,
                    background: C.white, color: C.text, outline: 'none',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button onClick={handleCancel}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.muted, fontSize: 13, cursor: 'pointer' }}>
                  <X size={13} /> Cancel
                </button>
                <button onClick={handleSave}
                  disabled={saving || !draft.trim() || !isModified}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '7px 18px', borderRadius: 8, border: 'none',
                    background: saving ? '#a5b4fc' : (isModified ? C.purple : C.border),
                    color: isModified ? '#fff' : C.muted,
                    fontSize: 13, fontWeight: 600, cursor: saving || !isModified ? 'not-allowed' : 'pointer',
                  }}>
                  {saving ? <span style={{ opacity: 0.8 }}>Saving…</span> : <><Save size={13} /> Save changes</>}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function PromptManager() {
  const [prompts,   setPrompts]   = useState<Prompt[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [filter,    setFilter]    = useState<'all' | 'customised' | 'default'>('all')
  const [search,    setSearch]    = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res  = await apiFetch('/api/prompts')
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || `HTTP ${res.status}`) }
      const data = await res.json()
      setPrompts(data.prompts || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleSave = async (id: string, text: string, notes: string) => {
    const res = await apiFetch(`/api/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, status: 'active', notes }),
    })
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Save failed') }
    setPrompts(prev => prev.map(p => p.id === id ? {
      ...p, customText: text, notes, isCustomised: true, status: 'active',
      updatedAt: new Date().toISOString(),
    } : p))
  }

  const handleReset = async (id: string) => {
    const res = await apiFetch(`/api/prompts/${id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Reset failed') }
    setPrompts(prev => prev.map(p => p.id === id ? {
      ...p, customText: null, notes: '', isCustomised: false, status: 'default',
      updatedAt: null, updatedBy: null,
    } : p))
  }

  const customisedCount = prompts.filter(p => p.isCustomised).length

  const visible = prompts.filter(p => {
    if (filter === 'customised' && !p.isCustomised) return false
    if (filter === 'default'    &&  p.isCustomised) return false
    if (search) {
      const q = search.toLowerCase()
      return p.id.toLowerCase().includes(q) || p.feature.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    }
    return true
  })

  const groups = visible.reduce((acc, p) => {
    if (!acc[p.feature]) acc[p.feature] = []
    acc[p.feature].push(p)
    return acc
  }, {} as Record<string, Prompt[]>)

  return (
    <div style={{ padding: '20px 24px', maxWidth: 900 }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 20 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: C.purpleL, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Sparkles size={20} color={C.purple} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>AI Prompts</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 2 }}>
            Customise the AI instructions for your organisation. Changes take effect immediately.
            {customisedCount > 0 && <span style={{ color: C.purple, fontWeight: 600 }}> · {customisedCount} customised</span>}
          </div>
        </div>
      </div>

      <div style={{ background: C.purpleL, borderRadius: 10, padding: '10px 14px', marginBottom: 18, fontSize: 12, color: '#5b21b6', lineHeight: 1.7, display: 'flex', gap: 8 }}>
        <Info size={14} style={{ marginTop: 2, flexShrink: 0 }} />
        <span>
          <strong>How it works:</strong> Each prompt has a system default. Click <strong>Edit</strong> on any prompt to override it for your organisation only — other orgs are unaffected. Click <strong>Reset</strong> to go back to the system default. Variables like <code style={{ background: '#ede9fe', padding: '1px 4px', borderRadius: 3 }}>{'{{orgName}}'}</code> are filled in automatically at runtime.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search prompts…"
          style={{ flex: 1, minWidth: 160, padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, outline: 'none', color: C.text }}
        />
        {(['all', 'customised', 'default'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{
              padding: '7px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${filter === f ? C.purple : C.border}`,
              background: filter === f ? C.purpleL : C.white,
              color: filter === f ? C.purple : C.muted, fontWeight: filter === f ? 600 : 400,
            }}>
            {f === 'all' ? `All (${prompts.length})` : f === 'customised' ? `Customised (${customisedCount})` : `Default (${prompts.length - customisedCount})`}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: C.muted, fontSize: 14 }}>Loading prompts…</div>
      )}

      {error && (
        <div style={{ background: C.redL, border: `1px solid #fca5a5`, borderRadius: 10, padding: '12px 16px', color: C.red, fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: C.muted, fontSize: 14 }}>No prompts match your filter.</div>
      )}

      {!loading && !error && Object.entries(groups).map(([feature, fps]) => {
        const fc = FEATURE_COLORS[feature] ?? { bg: C.light, text: C.muted }
        return (
          <div key={feature} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: fc.text, background: fc.bg, padding: '3px 10px', borderRadius: 99 }}>{feature}</span>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>
            {fps.map(p => (
              <PromptRow key={p.id} prompt={p} onSave={handleSave} onReset={handleReset} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
