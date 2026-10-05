// WhatsApp flows list with create/edit/publish/delete.

import { useState, useEffect } from 'react'
import {
  Plus, Edit3, Trash2, Play, Pause, Key, Loader2,
  MessageSquare, RefreshCw, AlertCircle, Clapperboard, LayoutTemplate,
  Sparkles, X,
} from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import type { WaFlow } from '../../types/whatsapp'
import { FlowBuilderCanvas } from './FlowBuilderCanvas'
import { FlowSimulator }  from './FlowSimulator'
import { FlowTemplates }  from './FlowTemplates'

export function FlowList() {
  const [flows, setFlows]           = useState<WaFlow[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')
  const [editing, setEditing]       = useState<WaFlow | null>(null)
  const [simFlow, setSimFlow]       = useState<WaFlow | null>(null)
  const [deleting, setDeleting]     = useState<string | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showAiGen, setShowAiGen]   = useState(false)
  const [aiPrompt, setAiPrompt]     = useState('')
  const [aiBusy, setAiBusy]         = useState(false)
  const [aiError, setAiError]       = useState('')

  async function handleAiGenerate() {
    if (!aiPrompt.trim() || aiBusy) return
    setAiBusy(true); setAiError('')
    try {
      const r = await apiFetch('/api/wa/flows/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: aiPrompt.trim() }),
      })
      const d = await r.json()
      if (!r.ok) { setAiError(d.error || 'Generation failed'); setAiBusy(false); return }
      // The generated draft opens in the editor for review before saving
      setEditing({
        name:             d.name || 'AI-generated flow',
        description:      d.description || '',
        trigger_keywords: d.trigger_keywords || [],
        nodes:            d.nodes || [],
        is_active:        false,
      } as WaFlow)
      setShowAiGen(false)
      setAiPrompt('')
    } catch (e: any) {
      setAiError(e.message || 'Network error')
    }
    setAiBusy(false)
  }

  async function fetchFlows() {
    setLoading(true); setError('')
    try {
      const r = await apiFetch('/api/wa/flows')
      const d = await r.json()
      setFlows(d.flows || [])
    } catch (e: any) {
      setError('Failed to load flows')
    }
    setLoading(false)
  }

  useEffect(() => { fetchFlows() }, [])

  function handleCreate() {
    const blank: WaFlow = {
      name:             'New Flow',
      description:      '',
      trigger_keywords: [],
      nodes:            [],
      is_active:        false,
    }
    setEditing(blank)
  }

  async function handleSave(flow: WaFlow) {
    const isNew = !flow.id
    const payload = {
      name:             flow.name,
      description:      flow.description || '',
      trigger_keywords: flow.trigger_keywords,
      nodes:            flow.nodes,
      is_default:       flow.is_default ?? false,
    }
    const res = await apiFetch(isNew ? '/api/wa/flows' : `/api/wa/flows/${flow.id}`, {
      method:  isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
    })
    const d = await res.json()
    if (!res.ok) throw new Error(d.error || 'Save failed')
    await fetchFlows()
    setEditing(null)
  }

  async function openEditor(flow: WaFlow) {
    // List rows lack nodes; fetch the full flow first
    try {
      const r = await apiFetch(`/api/wa/flows/${flow.id}`)
      const full = await r.json()
      setEditing({ ...flow, nodes: full.nodes || [] })
    } catch {
      setEditing({ ...flow, nodes: flow.nodes || [] })
    }
  }

  async function togglePublish(flow: WaFlow) {
    const res = await apiFetch(`/api/wa/flows/${flow.id}/publish`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ active: !flow.is_active }),
    })
    if (res.ok) await fetchFlows()
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this flow permanently?')) return
    setDeleting(id)
    const res = await apiFetch(`/api/wa/flows/${id}`, { method: 'DELETE' })
    if (res.ok) setFlows(f => f.filter(fl => fl.id !== id))
    setDeleting(null)
  }

  async function openSimulator(flow: WaFlow) {
    try {
      const r = await apiFetch(`/api/wa/flows/${flow.id}`)
      const full = await r.json()
      setSimFlow({ ...flow, nodes: full.nodes || [] })
    } catch {
      setSimFlow({ ...flow, nodes: flow.nodes || [] })
    }
  }

  if (editing) {
    return (
      <div className="h-full flex flex-col">
        <FlowBuilderCanvas
          flow={editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {simFlow && <FlowSimulator flow={simFlow} onClose={() => setSimFlow(null)} />}
      {showTemplates && (
        <FlowTemplates
          onSelect={templateFlow => setEditing({ ...templateFlow, nodes: templateFlow.nodes })}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {showAiGen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-[#D9E6E8] shadow-2xl w-full max-w-xl p-6 relative">
            <button onClick={() => !aiBusy && setShowAiGen(false)} className="absolute top-3 right-3 text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-5 h-5" style={{ color: '#9333ea' }} />
              <h3 className="font-bold text-lg" style={{ color: '#341272' }}>Generate a Flow with AI</h3>
            </div>
            <p className="text-xs text-gray-500 mb-4">Describe what you want in plain English. Gemini will draft the flow JSON, and you'll review it before saving.</p>

            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Describe your flow</label>
            <textarea
              rows={5}
              className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
              placeholder="e.g. Build a WASH baseline survey for fish farmers. Ask their name, village, pond size, and main crop. Then thank them and end."
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              disabled={aiBusy}
              autoFocus
            />

            <div className="mt-3 mb-3 text-[10px] text-gray-500 bg-purple-50 rounded-lg p-2 border border-purple-100">
              <strong>Tips for great flows:</strong> Mention what data to collect, branching logic ("if user says X…"), AI replies ("use AI to summarise…"), or escalation ("hand off to an agent if…"). Keep flows under 12 steps for best results.
            </div>

            {aiError && (
              <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {aiError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAiGen(false)}
                disabled={aiBusy}
                className="px-4 py-2 rounded-xl text-sm font-semibold border border-[#D9E6E8] hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAiGenerate}
                disabled={!aiPrompt.trim() || aiBusy}
                className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #9333ea 0%, #341272 100%)' }}
              >
                {aiBusy
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
                  : <><Sparkles className="w-4 h-4" /> Generate</>
                }
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-bold text-gray-900">Conversation Flows</h3>
          <p className="text-xs text-gray-500 mt-0.5">{flows.length} flows total</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={fetchFlows}
            className="w-9 h-9 rounded-xl border border-[#D9E6E8] flex items-center justify-center hover:bg-gray-50 transition"
          >
            <RefreshCw className="w-4 h-4 text-gray-500" />
          </button>
          <button
            onClick={() => setShowTemplates(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition border border-[#D9E6E8] hover:border-purple-300 hover:bg-purple-50 text-gray-700"
          >
            <LayoutTemplate className="w-4 h-4" /> Templates
          </button>
          <button
            onClick={() => setShowAiGen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition text-white"
            style={{ background: 'linear-gradient(135deg, #9333ea 0%, #341272 100%)' }}
          >
            <Sparkles className="w-4 h-4" /> Generate with AI
          </button>
          <button
            onClick={handleCreate}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition"
            style={{ background: '#341272' }}
          >
            <Plus className="w-4 h-4" /> New Flow
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 rounded-xl px-4 py-3">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
        </div>
      ) : flows.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-[#D9E6E8]">
          <div className="text-4xl mb-3">🤖</div>
          <p className="font-semibold text-gray-700">No flows yet</p>
          <p className="text-sm text-gray-400 mt-1 mb-5">Start from a template or build from scratch</p>
          <div className="flex items-center gap-3 justify-center flex-wrap px-4">
            <button
              onClick={() => setShowTemplates(true)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold border border-purple-300 text-purple-700 hover:bg-purple-50 transition"
            >
              <LayoutTemplate className="w-4 h-4" /> Use Template
            </button>
            <button
              onClick={handleCreate}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
              style={{ background: '#341272' }}
            >
              <Plus className="w-4 h-4" /> Build from Scratch
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {flows.map(flow => (
            <FlowCard
              key={flow.id}
              flow={flow}
              deleting={deleting === flow.id}
              onEdit={() => openEditor(flow)}
              onSimulate={() => openSimulator(flow)}
              onToggle={() => togglePublish(flow)}
              onDelete={() => handleDelete(flow.id!)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FlowCard({ flow, deleting, onEdit, onSimulate, onToggle, onDelete }: {
  flow:       WaFlow
  deleting:   boolean
  onEdit:     () => void
  onSimulate: () => void
  onToggle:   () => void
  onDelete:   () => void
}) {
  return (
    <div className="bg-white rounded-xl border border-[#D9E6E8] p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-xl"
            style={{ background: flow.is_active ? FF.greenBg : '#F3F4F6' }}
          >
            <MessageSquare
              className="w-5 h-5"
              style={{ color: flow.is_active ? FF.green : FF.textFaint }}
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-gray-900 text-sm">{flow.name}</span>
              {flow.is_default && (
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 flex items-center gap-1">
                  <Key className="w-2.5 h-2.5" /> DEFAULT
                </span>
              )}
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${flow.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {flow.is_active ? 'ACTIVE' : 'DRAFT'}
              </span>
            </div>
            {flow.description && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{flow.description}</p>
            )}
            <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400 flex-wrap">
              <span>{flow.node_count ?? flow.nodes?.length ?? 0} nodes</span>
              {flow.trigger_keywords?.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                  {flow.trigger_keywords.map(kw => (
                    <span key={kw} className="px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 font-semibold text-[9px]">
                      {kw}
                    </span>
                  ))}
                </div>
              )}
              {flow.updated_at && (
                <span>Updated {new Date(flow.updated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onSimulate}
            title="Simulate flow"
            className="w-8 h-8 rounded-xl flex items-center justify-center bg-green-50 hover:bg-green-100 text-green-700 transition"
          >
            <Clapperboard className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onToggle}
            title={flow.is_active ? 'Pause flow' : 'Activate flow'}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition ${flow.is_active ? 'bg-green-100 hover:bg-green-200 text-green-700' : 'bg-gray-100 hover:bg-gray-200 text-gray-500'}`}
          >
            {flow.is_active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onEdit}
            title="Edit flow"
            className="w-8 h-8 rounded-xl flex items-center justify-center bg-gray-100 hover:bg-purple-100 hover:text-purple-700 text-gray-500 transition"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            disabled={deleting}
            title="Delete flow"
            className="w-8 h-8 rounded-xl flex items-center justify-center bg-gray-100 hover:bg-red-100 hover:text-red-600 text-gray-400 transition disabled:opacity-50"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  )
}
