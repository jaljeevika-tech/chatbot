// Mind-map style WhatsApp flow builder on @xyflow/react.

import '@xyflow/react/dist/style.css'
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  MarkerType, Position, Handle, BackgroundVariant,
  type Node, type Edge, type NodeProps, type Connection,
} from '@xyflow/react'
import { useState, useCallback, useEffect, useRef, memo } from 'react'
import { X, Save, Play, Plus, Trash2, AlertCircle } from 'lucide-react'
import type { FlowNode, NodeType, WaFlow, ListOption, ButtonOption } from '../../types/whatsapp'
import { NODE_META } from '../../types/whatsapp'
import { FlowSimulator } from './FlowSimulator'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'

const NODE_W = 260
const NODE_H = 90
const X_GAP  = 90
const Y_GAP  = 130

let _ctr = 1
function nextId() { return `node_${Date.now()}_${_ctr++}` }

function defaultNode(type: NodeType): FlowNode {
  const id = nextId()
  const base: FlowNode = { id, type }
  switch (type) {
    case 'send_message': return { ...base, text: '' }
    case 'send_list':    return { ...base, header: 'Please select', text: 'Choose an option:', button_text: 'Select', section_title: 'Options', options: [{ id: '1', title: 'Option 1', description: '' }] }
    case 'send_buttons': return { ...base, text: 'Choose an option:', buttons: [{ id: '1', title: 'Yes' }, { id: '2', title: 'No' }] }
    case 'wait_input':   return { ...base, text: 'Please type your response:', save_as: 'response', validation: 'text' }
    case 'condition':    return { ...base, variable: '', operator: 'equals', value: '' }
    case 'webhook':      return { ...base, url: '', method: 'POST', body: {}, headers: {} }
    case 'set_field':    return { ...base, field: '', value: '' }
    case 'delay':        return { ...base, delay_seconds: 5 }
    case 'add_label':    return { ...base, label: '' }
    case 'enter_flow':   return { ...base, flow_name: '' }
    case 'human_handoff':return { ...base, notify_message: 'A team member will reply to you shortly.', notify_staff_phone: '' }
    case 'call_llm':     return { ...base, llm_prompt: '', llm_system_prompt: 'You are a helpful assistant. Reply in 1-3 sentences.', save_as: 'ai_response', llm_max_tokens: 512, llm_send_reply: true }
    case 'llm_router':   return { ...base, llm_prompt: '{{__last_text}}', llm_categories: [{ label: 'question', next: '' }, { label: 'complaint', next: '' }, { label: 'other', next: '' }], save_as: 'route', default_next: '' }
    case 'random_split': return { ...base, random_branches: [{ weight: 50, label: 'A', next: '' }, { weight: 50, label: 'B', next: '' }], save_as: 'variant' }
    case 'recap_confirm':return { ...base, intro_text: "Here's what I captured:", yes_label: 'YES', edit_label: 'EDIT', field_labels: {} }
    case 'update_contact':return { ...base, field: '', value: '' }
    case 'remove_label': return { ...base, label: '' }
    case 'end':          return { ...base, text: 'Thank you! Goodbye.' }
    default:             return base
  }
}

function nodePreview(n: FlowNode): string {
  switch (n.type) {
    case 'send_message': return n.text?.slice(0, 52) || '(no text)'
    case 'send_list':    return `${n.options?.length ?? 0} options → ${n.save_as || '?'}`
    case 'send_buttons': return `${n.buttons?.length ?? 0} buttons → ${n.save_as || '?'}`
    case 'wait_input':   return `→ ${n.save_as || '?'} (${n.validation || 'text'})`
    case 'condition':    return `{{${n.variable}}} ${n.operator} "${n.value}"`
    case 'webhook':      return `${n.method || 'POST'} ${n.url?.slice(0, 32) || '(no url)'}`
    case 'set_field':    return `${n.field} = ${n.value}`
    case 'delay':        return `Wait ${n.delay_seconds ?? 5}s`
    case 'add_label':    return `Label: ${n.label || '(none)'}`
    case 'enter_flow':   return `→ ${n.flow_name || '(no flow)'}`
    case 'human_handoff':return `🙋 Escalate to live agent${n.notify_staff_phone ? ` (+${n.notify_staff_phone})` : ''}`
    case 'call_llm':     return `✨ AI → ${n.save_as || 'ai_response'}${n.llm_send_reply ? ' (reply)' : ''}`
    case 'llm_router':   return `🧠 ${n.llm_categories?.length ?? 0} categories → ${n.save_as || 'route'}`
    case 'random_split': return `🎲 ${n.random_branches?.length ?? 0}-way split`
    case 'recap_confirm':return `📋 Recap → ${n.yes_label || 'YES'} / ${n.edit_label || 'EDIT'}`
    case 'update_contact':return `🟢 contact.${n.field || '?'} = ${n.value || ''}`
    case 'remove_label': return `🏷 Remove from "${n.label || '?'}"`
    case 'end':          return n.text?.slice(0, 52) || '(end)'
    default:             return ''
  }
}

// Auto-layout: BFS levels from root nodes
function autoLayout(flowNodes: FlowNode[]): Record<string, { x: number; y: number }> {
  if (!flowNodes.length) return {}

  const outEdges = new Map<string, string[]>()
  const inDeg    = new Map<string, number>()
  for (const n of flowNodes) { outEdges.set(n.id, []); inDeg.set(n.id, 0) }

  for (const n of flowNodes) {
    const nexts = [n.next, n.next_true, n.next_false, n.next_on_error]
      .filter((x): x is string => !!x && outEdges.has(x))
    for (const nx of nexts) {
      outEdges.get(n.id)!.push(nx)
      inDeg.set(nx, (inDeg.get(nx) ?? 0) + 1)
    }
  }

  const level = new Map<string, number>()
  const queue = flowNodes.filter(n => (inDeg.get(n.id) ?? 0) === 0).map(n => n.id)
  for (const id of queue) level.set(id, 0)

  let qi = 0
  while (qi < queue.length) {
    const id = queue[qi++]
    const lv = level.get(id) ?? 0
    for (const child of outEdges.get(id) ?? []) {
      if (!level.has(child) || level.get(child)! < lv + 1) {
        level.set(child, lv + 1)
        if (!queue.includes(child)) queue.push(child)
      }
    }
  }

  // Isolated / cycle nodes
  let maxLv = -1
  for (const v of level.values()) if (v > maxLv) maxLv = v
  for (const n of flowNodes) if (!level.has(n.id)) level.set(n.id, ++maxLv)

  const byLevel: Record<number, string[]> = {}
  for (const [id, lv] of level) {
    if (!byLevel[lv]) byLevel[lv] = []
    byLevel[lv].push(id)
  }

  const pos: Record<string, { x: number; y: number }> = {}
  for (const [lvStr, ids] of Object.entries(byLevel)) {
    const lv      = Number(lvStr)
    const totalW  = ids.length * NODE_W + (ids.length - 1) * X_GAP
    const startX  = -totalW / 2
    ids.forEach((id, i) => {
      pos[id] = { x: startX + i * (NODE_W + X_GAP), y: lv * (NODE_H + Y_GAP) }
    })
  }
  return pos
}

function toRfFormat(flowNodes: FlowNode[]): { nodes: Node[]; edges: Edge[] } {
  const positions = autoLayout(flowNodes)
  const nodes: Node[] = flowNodes.map(fn => ({
    id:       fn.id,
    type:     'flowNode',
    position: positions[fn.id] ?? { x: 0, y: 0 },
    data:     { ...fn } as Record<string, unknown>,
  }))

  const edges: Edge[] = []
  for (const fn of flowNodes) {
    const push = (handle: string, target: string, label: string, color: string) => {
      edges.push({
        id:          `e_${fn.id}_${handle}`,
        source:      fn.id,
        sourceHandle: handle,
        target,
        targetHandle: 'in',
        type:         'smoothstep',
        animated:     true,
        label,
        labelStyle:   { fontSize: 9, fontWeight: 700, fill: color },
        style:        { stroke: color, strokeWidth: 1.5 },
        markerEnd:    { type: MarkerType.ArrowClosed, color },
      })
    }
    if (fn.next)          push('default', fn.next,          '',           '#94a3b8')
    if (fn.next_true)     push('true',    fn.next_true,     '✅ TRUE',    FF.green)
    if (fn.next_false)    push('false',   fn.next_false,    '❌ FALSE',   FF.red)
    if (fn.next_on_error) push('err',     fn.next_on_error, '⚠️ Error',   FF.amber)
  }
  return { nodes, edges }
}

function fromRfFormat(rfNodes: Node[], rfEdges: Edge[]): FlowNode[] {
  const edgeMap = new Map<string, string>()
  for (const e of rfEdges) {
    edgeMap.set(`${e.source}::${e.sourceHandle ?? 'default'}`, e.target)
  }

  return rfNodes.map(rfNode => {
    const fn = { ...(rfNode.data as unknown as FlowNode) }
    // Rebuilt from edges below
    delete fn.next; delete fn.next_true; delete fn.next_false; delete fn.next_on_error

    if (fn.type === 'condition') {
      const t = edgeMap.get(`${rfNode.id}::true`)
      const f = edgeMap.get(`${rfNode.id}::false`)
      if (t) fn.next_true  = t
      if (f) fn.next_false = f
    } else if (fn.type === 'webhook') {
      const ok  = edgeMap.get(`${rfNode.id}::ok`) ?? edgeMap.get(`${rfNode.id}::default`)
      const err = edgeMap.get(`${rfNode.id}::err`)
      if (ok)  fn.next          = ok
      if (err) fn.next_on_error = err
    } else {
      const def = edgeMap.get(`${rfNode.id}::default`)
      if (def) fn.next = def
    }
    return fn
  })
}

const FlowNodeCard = memo(function FlowNodeCard({ data, selected }: NodeProps) {
  const fn   = data as unknown as FlowNode
  const meta = NODE_META[fn.type] ?? { label: fn.type, icon: '❓', color: '#9ca3af' }
  const isCondition = fn.type === 'condition'
  const isWebhook   = fn.type === 'webhook'
  const isEnd       = fn.type === 'end'

  return (
    <div style={{
      width:        NODE_W,
      borderRadius: 16,
      border:       `2px solid ${selected ? meta.color : FF.border}`,
      background:   'white',
      boxShadow:    selected
        ? `0 0 0 4px ${meta.color}33, 0 4px 20px rgba(0,0,0,0.12)`
        : '0 2px 8px rgba(0,0,0,0.06)',
      overflow:     'hidden',
      transition:   'box-shadow 0.15s, border-color 0.15s',
      cursor:       'pointer',
      fontFamily:   'inherit',
    }}>
      <Handle
        type="target" position={Position.Top} id="in"
        style={{ width: 12, height: 12, background: '#94a3b8', border: '2px solid white', top: -6 }}
      />

      <div style={{ borderLeft: `4px solid ${meta.color}`, padding: '10px 12px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{meta.icon}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontWeight: 700, fontSize: 12, color: '#111827',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {fn.node_label || meta.label}
            </div>
            <div style={{
              fontSize: 10, color: '#9ca3af', marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {nodePreview(fn)}
            </div>
            {selected && (
              <div style={{ marginTop: 3, fontSize: 9, color: meta.color, fontWeight: 700 }}>
                EDITING IN PANEL ›
              </div>
            )}
          </div>
        </div>
      </div>

      {!isEnd && (
        <>
          {(isCondition || isWebhook) && (
            <div style={{
              display: 'flex', justifyContent: 'space-around',
              padding: '3px 8px 5px', background: '#f9fafb',
              borderTop: '1px solid #f3f4f6',
            }}>
              {isCondition && (
                <>
                  <span style={{ fontSize: 8, color: FF.green, fontWeight: 700 }}>✅ TRUE</span>
                  <span style={{ fontSize: 8, color: FF.red, fontWeight: 700 }}>❌ FALSE</span>
                </>
              )}
              {isWebhook && (
                <>
                  <span style={{ fontSize: 8, color: '#059669', fontWeight: 700 }}>✅ OK</span>
                  <span style={{ fontSize: 8, color: FF.amber, fontWeight: 700 }}>⚠️ ERR</span>
                </>
              )}
            </div>
          )}

          {isCondition ? (
            <>
              <Handle type="source" position={Position.Bottom} id="true"
                style={{ left: '30%', width: 12, height: 12, background: FF.green, border: '2px solid white', bottom: -6 }}
              />
              <Handle type="source" position={Position.Bottom} id="false"
                style={{ left: '70%', width: 12, height: 12, background: FF.red, border: '2px solid white', bottom: -6 }}
              />
            </>
          ) : isWebhook ? (
            <>
              <Handle type="source" position={Position.Bottom} id="ok"
                style={{ left: '30%', width: 12, height: 12, background: '#059669', border: '2px solid white', bottom: -6 }}
              />
              <Handle type="source" position={Position.Bottom} id="err"
                style={{ left: '70%', width: 12, height: 12, background: FF.amber, border: '2px solid white', bottom: -6 }}
              />
            </>
          ) : (
            <Handle type="source" position={Position.Bottom} id="default"
              style={{ width: 12, height: 12, background: meta.color, border: '2px solid white', bottom: -6 }}
            />
          )}
        </>
      )}
    </div>
  )
})

// Defined outside the component so ReactFlow doesn't remount nodes every render
const NODE_TYPES = { flowNode: FlowNodeCard }

interface Props {
  flow:     WaFlow
  onSave:   (updated: WaFlow) => Promise<void>
  onCancel: () => void
}

export function FlowBuilderCanvas({ flow: initialFlow, onSave, onCancel }: Props) {
  const [flow, setFlow]                            = useState<WaFlow>({ ...initialFlow })
  const [rfNodes, setRfNodes, onNodesChange]       = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange]       = useEdgesState<Edge>([])
  const [selectedId, setSelectedId]                = useState<string | null>(null)
  const [saving,  setSaving]                       = useState(false)
  const [error,   setError]                        = useState('')
  const [addOpen, setAddOpen]                      = useState(false)
  const [simOpen, setSimOpen]                      = useState(false)

  useEffect(() => {
    const { nodes, edges } = toRfFormat(initialFlow.nodes)
    setRfNodes(nodes)
    setRfEdges(edges)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onConnect = useCallback((params: Connection) => {
    const h     = params.sourceHandle ?? 'default'
    const color = h === 'true' ? FF.green : h === 'false' ? FF.red : h === 'err' ? FF.amber : '#94a3b8'
    const label = h === 'true' ? '✅ TRUE'  : h === 'false' ? '❌ FALSE' : h === 'err' ? '⚠️ Error' : ''
    setRfEdges(eds => addEdge({
      ...params,
      type:       'smoothstep',
      animated:   true,
      style:      { stroke: color, strokeWidth: 1.5 },
      label,
      labelStyle: { fontSize: 9, fontWeight: 700, fill: color },
      markerEnd:  { type: MarkerType.ArrowClosed, color },
    }, eds))
  }, [setRfEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id)
    setAddOpen(false)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedId(null)
    setAddOpen(false)
  }, [])

  const updateNodeData = useCallback((patch: Partial<FlowNode>) => {
    setRfNodes(nds =>
      nds.map(n =>
        n.id === selectedId
          ? { ...n, data: { ...n.data, ...patch } as Record<string, unknown> }
          : n
      )
    )
  }, [selectedId, setRfNodes])

  function addNode(type: NodeType) {
    const fn   = defaultNode(type)
    const maxY = rfNodes.reduce((m, n) => Math.max(m, n.position.y), -160)
    const newRfNode: Node = {
      id:       fn.id,
      type:     'flowNode',
      position: { x: 0, y: maxY + 200 },
      data:     { ...fn } as Record<string, unknown>,
    }
    setRfNodes(nds => [...nds, newRfNode])
    setSelectedId(fn.id)
    setAddOpen(false)
  }

  function deleteSelected() {
    if (!selectedId) return
    setRfNodes(nds => nds.filter(n => n.id !== selectedId))
    setRfEdges(eds => eds.filter(e => e.source !== selectedId && e.target !== selectedId))
    setSelectedId(null)
  }

  async function handleSave() {
    setSaving(true); setError('')
    try {
      const updatedNodes = fromRfFormat(rfNodes, rfEdges)
      await onSave({ ...flow, nodes: updatedNodes })
    } catch (e: any) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const selectedNode = selectedId
    ? rfNodes.find(n => n.id === selectedId)?.data as unknown as FlowNode | undefined
    : undefined

  const nodeOptions = rfNodes.map(n => ({
    id:    n.id,
    label: ((n.data as unknown as FlowNode).node_label)
      || NODE_META[(n.data as unknown as FlowNode).type]?.label
      || 'Node',
  }))

  // Live preview flow for the simulator
  const simFlow: WaFlow = { ...flow, nodes: fromRfFormat(rfNodes, rfEdges) }

  return (
    <div className="flex flex-col h-full">
      {simOpen && <FlowSimulator flow={simFlow} onClose={() => setSimOpen(false)} />}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3 border-b border-gray-100 bg-white shrink-0 z-10">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 transition shrink-0">
            <X className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0">
            <input
              className="font-bold text-gray-900 text-sm w-full focus:outline-none border-b border-transparent hover:border-[#D9E6E8] focus:border-purple-400 py-0.5 transition bg-transparent"
              value={flow.name}
              onChange={e => setFlow(f => ({ ...f, name: e.target.value }))}
              placeholder="Flow name…"
            />
            <input
              className="text-xs text-gray-400 focus:outline-none bg-transparent border-b border-transparent hover:border-[#D9E6E8] focus:border-purple-400 transition w-full mt-0.5"
              placeholder="trigger keywords, comma-separated (e.g. hi, hello, start)"
              value={flow.trigger_keywords.join(', ')}
              onChange={e => setFlow(f => ({
                ...f,
                trigger_keywords: e.target.value.split(',').map(k => k.trim()).filter(Boolean),
              }))}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {error && (
            <div className="flex items-center gap-1.5 text-red-500 text-xs shrink-0">
              <AlertCircle className="w-3.5 h-3.5" /> {error}
            </div>
          )}

          <label className="hidden md:flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer shrink-0 mr-2" title="Prepend [Q n/m] to question prompts so contacts see their progress">
            <input
              type="checkbox"
              checked={!!flow.show_progress}
              onChange={e => setFlow(f => ({ ...f, show_progress: e.target.checked }))}
              className="w-3.5 h-3.5 accent-purple-600"
            />
            <span>Show <em>[Q n/m]</em></span>
          </label>

          <span className="text-xs text-gray-400 shrink-0 hidden sm:block">
            {rfNodes.length} nodes
          </span>

          <button
            onClick={() => setSimOpen(true)}
            disabled={rfNodes.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 shrink-0"
            style={{ background: '#E8F5E9', color: '#128C7E' }}
          >
            <Play className="w-3.5 h-3.5" /> Simulate
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white transition-all disabled:opacity-60 shrink-0"
            style={{ background: '#341272' }}
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save Flow'}
          </button>
        </div>
      </div>

      {/* Mobile notice: the canvas is built for larger screens */}
      <div className="lg:hidden mx-4 mt-3 sm:mx-5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 shrink-0">
        ⚠️ Flow Builder works best on a tablet or larger screen.
      </div>

      {/* Canvas + property panel */}
      <div className="flex flex-1 min-h-0 relative">

        <div className="flex-1 relative bg-slate-50">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.15}
            maxZoom={2}
            deleteKeyCode="Delete"
            multiSelectionKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cbd5e1" />
            <Controls showInteractive={false} className="rounded-xl overflow-hidden border border-[#D9E6E8] shadow-sm" />
            <MiniMap
              nodeColor={n => NODE_META[(n.data as unknown as FlowNode)?.type]?.color ?? '#9ca3af'}
              maskColor="rgba(241,245,249,0.85)"
              style={{ borderRadius: 12, border: '1px solid #e2e8f0' }}
            />
          </ReactFlow>

          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10">
            <div className="relative">
              <button
                onClick={() => setAddOpen(v => !v)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white shadow-lg hover:shadow-xl transition-all"
                style={{ background: '#341272' }}
              >
                <Plus className="w-4 h-4" />
                Add Node
              </button>

              {addOpen && (
                <div
                  className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 bg-white rounded-xl border border-[#D9E6E8] shadow-2xl overflow-hidden"
                  style={{ width: 340 }}
                >
                  <div className="px-4 py-2.5 border-b border-gray-50 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                    Choose Node Type
                  </div>
                  <div className="p-2 grid grid-cols-2 gap-1 max-h-72 overflow-auto">
                    {(Object.keys(NODE_META) as NodeType[]).map(type => {
                      const m = NODE_META[type]
                      return (
                        <button
                          key={type}
                          onClick={() => addNode(type)}
                          className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-gray-50 text-left transition group"
                        >
                          <span className="text-xl shrink-0">{m.icon}</span>
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-gray-800 group-hover:text-gray-900">{m.label}</div>
                            <div
                              className="text-[9px] text-gray-400 truncate mt-0.5"
                              style={{ borderLeft: `2px solid ${m.color}`, paddingLeft: 4 }}
                            >
                              {m.label.toLowerCase()}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {rfNodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="text-5xl mb-3 opacity-40">🤖</div>
                <p className="font-semibold text-gray-400 text-sm">Start building your flow</p>
                <p className="text-xs text-gray-300 mt-1">Click "Add Node" below to place your first node</p>
              </div>
            </div>
          )}
        </div>

        {/* Property panel */}
        {selectedNode && (
          <div className="absolute inset-0 z-20 lg:static lg:inset-auto lg:z-auto w-full lg:w-80 lg:shrink-0 flex flex-col bg-white lg:border-l border-gray-100 overflow-hidden">
            <div
              className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0"
              style={{ borderLeft: `4px solid ${NODE_META[selectedNode.type]?.color ?? '#9ca3af'}` }}
            >
              <span className="text-lg shrink-0">{NODE_META[selectedNode.type]?.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-gray-900 text-sm">{NODE_META[selectedNode.type]?.label}</div>
                <div className="text-[10px] text-gray-400 truncate">
                  {nodePreview(selectedNode)}
                </div>
              </div>
              <button
                onClick={deleteSelected}
                title="Delete node"
                className="w-7 h-7 rounded-xl flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setSelectedId(null)}
                className="w-7 h-7 rounded-xl flex items-center justify-center text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
              <InputField
                label="Node Name (shown on canvas)"
                value={selectedNode.node_label || ''}
                onChange={v => updateNodeData({ node_label: v })}
                placeholder={NODE_META[selectedNode.type]?.label ?? selectedNode.type}
              />
              <hr className="border-gray-100" />
              <NodeEditor
                node={selectedNode}
                nodeOptions={nodeOptions.filter(o => o.id !== selectedId)}
                onChange={updateNodeData}
              />
            </div>

            {/* Click a pill to insert into the focused field */}
            <VariablesPanel flowNodes={rfNodes.map(n => n.data as unknown as FlowNode)} />
          </div>
        )}
      </div>
    </div>
  )
}

function NodeEditor({
  node, nodeOptions, onChange,
}: {
  node:        FlowNode
  nodeOptions: Array<{ id: string; label: string }>
  onChange:    (patch: Partial<FlowNode>) => void
}) {
  // Hooks must run unconditionally, so this loads even for non-handoff nodes.
  const [assignableUsers, setAssignableUsers] = useState<Array<{ id: string; name: string; role: string; designation: string }>>([])
  useEffect(() => {
    let abort = false
    apiFetch('/api/wa/assignable-users')
      .then(r => r.ok ? r.json() : { users: [] })
      .then(d => { if (!abort) setAssignableUsers(d.users || []) })
      .catch(() => {})
    return () => { abort = true }
  }, [])

  switch (node.type) {

    case 'send_message':
      return (
        <>
          <TextArea label="Message Text" placeholder="Hello {{contact.name}}! Welcome…" value={node.text || ''} onChange={v => onChange({ text: v })} />
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'send_list':
      return (
        <>
          <InputField label="Header"        value={node.header || ''}        onChange={v => onChange({ header: v })}        placeholder="Please select" />
          <InputField label="Button Text"   value={node.button_text || ''}   onChange={v => onChange({ button_text: v })}   placeholder="Select" />
          <TextArea   label="Body Text"     value={node.text || ''}          onChange={v => onChange({ text: v })}           placeholder="Choose an option:" />
          <InputField label="Section Title" value={node.section_title || ''} onChange={v => onChange({ section_title: v })} placeholder="Options" />
          <InputField label="Save as"       value={node.save_as || ''}       onChange={v => onChange({ save_as: v })}       placeholder="selected_option" />
          <OptionList label="List Options (up to 10)" options={node.options || []} max={10} onChange={opts => onChange({ options: opts })} hasDescription />
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'send_buttons':
      return (
        <>
          <TextArea   label="Body Text" value={node.text || ''}    onChange={v => onChange({ text: v })}     placeholder="Choose an option:" />
          <InputField label="Save as"   value={node.save_as || ''} onChange={v => onChange({ save_as: v })} placeholder="user_choice" />
          <ButtonList buttons={node.buttons || []} onChange={btns => onChange({ buttons: btns })} />
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'wait_input':
      return (
        <>
          <TextArea   label="Prompt Text"      value={node.text || ''}    onChange={v => onChange({ text: v })}      placeholder="Please enter your name:" />
          <InputField label="Example (optional)" value={node.example || ''} onChange={v => onChange({ example: v })} placeholder="Ramesh Kumar" />
          <p className="text-[10px] text-gray-400">Shown to the contact as <em>"e.g. ..."</em> hint below the prompt. Voice notes are auto-transcribed.</p>
          <InputField label="Save response as" value={node.save_as || ''} onChange={v => onChange({ save_as: v })} placeholder="user_name" />
          <SelectField
            label="Validation"
            value={node.validation || 'text'}
            options={[
              { value: 'text',   label: 'Text (any)'   },
              { value: 'number', label: 'Number only'  },
              { value: 'phone',  label: 'Phone number' },
              { value: 'image',  label: '📷 Photo only' },
            ]}
            onChange={v => onChange({ validation: v as any })}
          />
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'condition':
      return (
        <>
          <InputField  label="Variable" value={node.variable || ''} onChange={v => onChange({ variable: v })} placeholder="e.g. user_choice" />
          <SelectField
            label="Operator"
            value={node.operator || 'equals'}
            options={[
              { value: 'equals',      label: 'Equals'      },
              { value: 'contains',    label: 'Contains'    },
              { value: 'starts_with', label: 'Starts with' },
              { value: 'not_empty',   label: 'Not empty'   },
              { value: 'is_number',   label: 'Is number'   },
            ]}
            onChange={v => onChange({ operator: v as any })}
          />
          {node.operator !== 'not_empty' && node.operator !== 'is_number' && (
            <InputField label="Compare Value" value={node.value || ''} onChange={v => onChange({ value: v })} placeholder="compare value" />
          )}
          <div className="rounded-xl bg-green-50 border border-green-100 px-3 py-2 text-[10px] text-green-700">
            💡 Drag from the <strong>✅ TRUE</strong> / <strong>❌ FALSE</strong> handles on the node card to connect branches
          </div>
        </>
      )

    case 'webhook':
      return (
        <>
          <SelectField
            label="Method"
            value={node.method || 'POST'}
            options={[{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }]}
            onChange={v => onChange({ method: v as 'POST' | 'GET' })}
          />
          <InputField label="URL" value={node.url || ''} onChange={v => onChange({ url: v })} placeholder="https://your-api.com/endpoint" />
          <KVEditor label="Request Body"  value={node.body || {}}    onChange={v => onChange({ body: v })}    placeholder_k="field"       placeholder_v="{{variable}}" />
          <KVEditor label="Extra Headers" value={node.headers || {}} onChange={v => onChange({ headers: v })} placeholder_k="Header-Name" placeholder_v="value" />
          <div className="rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-[10px] text-amber-700">
            💡 Drag from <strong>✅ OK</strong> / <strong>⚠️ ERR</strong> handles on the node to route success and error paths
          </div>
          <p className="text-[10px] text-gray-400">Response JSON is flattened into <code>{'{{webhook_key}}'}</code> variables</p>
        </>
      )

    case 'set_field':
      return (
        <>
          <InputField label="Field Name" value={node.field || ''} onChange={v => onChange({ field: v })} placeholder="project_name" />
          <InputField label="Value"      value={node.value || ''} onChange={v => onChange({ value: v })} placeholder="{{some_variable}} or literal" />
          <NextSelect label="Next Node"  value={node.next}        options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'delay':
      return (
        <>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Wait Duration (seconds)</label>
            <input
              type="number" min={1} max={3600}
              className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              value={node.delay_seconds ?? 5}
              onChange={e => onChange({ delay_seconds: Number(e.target.value) })}
            />
            <p className="text-[10px] text-gray-400 mt-0.5">1–3600 seconds — adds a timed pause before the next node.</p>
          </div>
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'add_label':
      return (
        <>
          <InputField label="Label / Tag name" value={node.label || ''} onChange={v => onChange({ label: v })} placeholder="interested, opted-out, vip" />
          <p className="text-[10px] text-gray-400">Labels the contact for filtering and analytics.</p>
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'enter_flow':
      return (
        <>
          <InputField label="Sub-Flow Name" value={node.flow_name || ''} onChange={v => onChange({ flow_name: v })} placeholder="Support Flow" />
          <p className="text-[10px] text-gray-400">Transfers the contact into another flow. The current flow ends here.</p>
        </>
      )

    case 'human_handoff':
      return (
        <>
          <TextArea
            label="Message to Contact"
            value={node.notify_message || ''}
            onChange={v => onChange({ notify_message: v })}
            placeholder="A team member will reply to you shortly."
          />
          <p className="text-[10px] text-gray-400">Sent to the contact when the bot escalates. Supports {`{{variables}}`}.</p>
          <InputField
            label="Notify Staff Phone (optional)"
            value={node.notify_staff_phone || ''}
            onChange={v => onChange({ notify_staff_phone: v.replace(/\D/g, '') })}
            placeholder="919876543210"
          />
          <p className="text-[10px] text-gray-400">If set, this number gets a WhatsApp ping with conversation context. Otherwise the conversation appears in the "Needs Reply" tab of Conversations.</p>

          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Assign To (optional)</label>
            <div className="space-y-1 max-h-40 overflow-auto rounded-xl border border-[#D9E6E8] p-2">
              {assignableUsers.length === 0 ? (
                <p className="text-[10px] text-gray-400 px-1">No managers/admins found in this org.</p>
              ) : (
                assignableUsers.map(u => {
                  const checked = (node.assign_to_users || []).includes(u.id)
                  return (
                    <label key={u.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-purple-50 rounded px-1 py-0.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => {
                          const current = node.assign_to_users || []
                          const next = e.target.checked
                            ? [...current, u.id]
                            : current.filter(x => x !== u.id)
                          onChange({ assign_to_users: next })
                        }}
                        className="w-3.5 h-3.5 accent-purple-600"
                      />
                      <span className="font-medium text-gray-700">{u.name}</span>
                      <span className="text-[10px] text-gray-400">· {u.role}{u.designation ? ` · ${u.designation}` : ''}</span>
                    </label>
                  )
                })
              )}
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              When selected, handoff goes directly to one of these users' inbox.
              If empty, falls back to the contact's project field, then to the global "Needs Reply" queue.
            </p>
          </div>

          <div className="mt-2 p-2 rounded-lg bg-red-50 border border-red-100">
            <p className="text-[10px] text-red-700 font-semibold">⚠ Flow ends here. The bot stops responding until an agent clicks "Return to bot".</p>
          </div>
        </>
      )

    case 'call_llm':
      return (
        <>
          <TextArea
            label="Prompt to LLM"
            value={node.llm_prompt || ''}
            onChange={v => onChange({ llm_prompt: v })}
            placeholder="Generate a personalised reminder for {{contact.name}} about their {{crop}} farming. Include 2 specific tips."
          />
          <p className="text-[10px] text-gray-400">Uses {`{{variables}}`} and {`{{contact.name}}`}. Reply is saved to the variable below.</p>

          <TextArea
            label="System Instruction (optional)"
            value={node.llm_system_prompt || ''}
            onChange={v => onChange({ llm_system_prompt: v })}
            placeholder="You are a helpful assistant. Reply in 1-3 sentences."
          />

          <InputField
            label="Save Response As"
            value={node.save_as || ''}
            onChange={v => onChange({ save_as: v.replace(/[^a-zA-Z0-9_]/g, '_') })}
            placeholder="ai_response"
          />

          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Max Output Tokens</label>
            <input
              type="number"
              min={64} max={2048} step={64}
              className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              value={node.llm_max_tokens ?? 512}
              onChange={e => onChange({ llm_max_tokens: parseInt(e.target.value) || 512 })}
            />
            <p className="text-[10px] text-gray-400 mt-1">~4 tokens ≈ 1 English word. Lower = cheaper + faster.</p>
          </div>

          <label className="flex items-center gap-2 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!node.llm_send_reply}
              onChange={e => onChange({ llm_send_reply: e.target.checked })}
              className="w-4 h-4 accent-purple-600"
            />
            <span className="text-xs text-gray-700">Send response directly to contact</span>
          </label>
          <p className="text-[10px] text-gray-400">If unchecked, the response is stored in the variable only — use it in later nodes.</p>

          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'llm_router': {
      const cats = node.llm_categories || []
      const updateCat = (i: number, patch: Partial<{ label: string; next: string }>) => {
        const next = cats.map((c, idx) => idx === i ? { ...c, ...patch } : c)
        onChange({ llm_categories: next })
      }
      const addCat    = () => onChange({ llm_categories: [...cats, { label: '', next: '' }] })
      const removeCat = (i: number) => onChange({ llm_categories: cats.filter((_, idx) => idx !== i) })

      return (
        <>
          <TextArea
            label="Input to Classify"
            value={node.llm_prompt || ''}
            onChange={v => onChange({ llm_prompt: v })}
            placeholder="{{__last_text}}"
          />
          <p className="text-[10px] text-gray-400">Usually <code>{`{{__last_text}}`}</code> (user's latest message). Can reference any variable.</p>

          <InputField label="Save Match As" value={node.save_as || ''} onChange={v => onChange({ save_as: v.replace(/[^a-zA-Z0-9_]/g, '_') })} placeholder="route" />

          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Categories</label>
            <div className="space-y-2">
              {cats.map((c, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input
                    className="flex-1 rounded-lg border border-[#D9E6E8] px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300"
                    placeholder={`Category ${i + 1}`}
                    value={c.label}
                    onChange={e => updateCat(i, { label: e.target.value })}
                  />
                  <select
                    className="rounded-lg border border-[#D9E6E8] px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-purple-300"
                    value={c.next}
                    onChange={e => updateCat(i, { next: e.target.value })}
                  >
                    <option value="">→ none</option>
                    {nodeOptions.map(o => <option key={o.id} value={o.id}>→ {o.label}</option>)}
                  </select>
                  <button onClick={() => removeCat(i)} className="text-red-500 text-xs px-1.5 hover:bg-red-50 rounded">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button onClick={addCat} className="text-[11px] text-purple-600 hover:underline flex items-center gap-1">
                <Plus className="w-3 h-3" /> Add category
              </button>
            </div>
          </div>

          <NextSelect label="Default (fallback) Next" value={node.default_next} options={nodeOptions} onChange={v => onChange({ default_next: v })} />
          <p className="text-[10px] text-gray-400">Uses Gemini to pick the category whose label best matches the input. Routes to that category's Next, or the default if Gemini can't decide.</p>
        </>
      )
    }

    case 'random_split': {
      const bs = node.random_branches || []
      const updateB = (i: number, patch: Partial<{ weight: number; label: string; next: string }>) => {
        const next = bs.map((b, idx) => idx === i ? { ...b, ...patch } : b)
        onChange({ random_branches: next })
      }
      const addB    = () => onChange({ random_branches: [...bs, { weight: 50, label: `Branch ${bs.length + 1}`, next: '' }] })
      const removeB = (i: number) => onChange({ random_branches: bs.filter((_, idx) => idx !== i) })
      const totalW  = bs.reduce((s, b) => s + (Number(b.weight) || 0), 0)

      return (
        <>
          <InputField label="Save Branch As" value={node.save_as || ''} onChange={v => onChange({ save_as: v.replace(/[^a-zA-Z0-9_]/g, '_') })} placeholder="variant" />

          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">Weighted Branches</label>
            <div className="space-y-2">
              {bs.map((b, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input
                    type="number" min={1} max={100} step={1}
                    className="w-14 rounded-lg border border-[#D9E6E8] px-2 py-1.5 text-xs text-center focus:outline-none focus:ring-2 focus:ring-purple-300"
                    value={b.weight}
                    onChange={e => updateB(i, { weight: parseInt(e.target.value) || 1 })}
                  />
                  <input
                    className="flex-1 rounded-lg border border-[#D9E6E8] px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300"
                    placeholder={`Label`}
                    value={b.label}
                    onChange={e => updateB(i, { label: e.target.value })}
                  />
                  <select
                    className="rounded-lg border border-[#D9E6E8] px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-purple-300"
                    value={b.next}
                    onChange={e => updateB(i, { next: e.target.value })}
                  >
                    <option value="">→ none</option>
                    {nodeOptions.map(o => <option key={o.id} value={o.id}>→ {o.label}</option>)}
                  </select>
                  <button onClick={() => removeB(i)} className="text-red-500 text-xs px-1.5 hover:bg-red-50 rounded">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button onClick={addB} className="text-[11px] text-cyan-600 hover:underline flex items-center gap-1">
                <Plus className="w-3 h-3" /> Add branch
              </button>
            </div>
            {totalW > 0 && (
              <p className="text-[10px] text-gray-400 mt-2">
                Distribution: {bs.map((b, i) => <span key={i}>{b.label || `B${i + 1}`}: <strong>{Math.round((b.weight / totalW) * 100)}%</strong>{i < bs.length - 1 ? ' · ' : ''}</span>)}
              </p>
            )}
          </div>
        </>
      )
    }

    case 'recap_confirm':
      return (
        <>
          <TextArea
            label="Intro Line"
            value={node.intro_text || ''}
            onChange={v => onChange({ intro_text: v })}
            placeholder="Here's what I captured:"
          />
          <p className="text-[10px] text-gray-400">A summary of all collected answers will appear below this line. The user replies YES to save or EDIT to fix something.</p>
          <div className="grid grid-cols-2 gap-2">
            <InputField label="YES Label" value={node.yes_label || ''} onChange={v => onChange({ yes_label: v })} placeholder="YES" />
            <InputField label="EDIT Label" value={node.edit_label || ''} onChange={v => onChange({ edit_label: v })} placeholder="EDIT" />
          </div>
          <NextSelect label="On YES → Next" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
          <NextSelect label="On EDIT → Jump To" value={node.next_edit} options={nodeOptions} onChange={v => onChange({ next_edit: v })} />
          <div className="mt-2 p-2 rounded-lg bg-teal-50 border border-teal-100">
            <p className="text-[10px] text-teal-700">💡 Tip: point <strong>EDIT</strong> at your first <code>wait_input</code> so the user can restart the survey if they spot a mistake.</p>
          </div>
        </>
      )

    case 'update_contact':
      return (
        <>
          <div className="rounded-lg bg-green-50 border border-green-100 px-2 py-2 text-[10px] text-green-700">
            🟢 <strong>Global write.</strong> This value is saved on the contact's profile (wa_contacts.fields). It can be read in ANY future flow as <code>{`{{contact.${node.field || 'fieldname'}}}`}</code>.
          </div>
          <InputField
            label="Contact Field Name"
            value={node.field || ''}
            onChange={v => onChange({ field: v.replace(/[^a-zA-Z0-9_]/g, '_') })}
            placeholder="preferred_language"
          />
          <InputField
            label="Value (supports {{vars}})"
            value={node.value || ''}
            onChange={v => onChange({ value: v })}
            placeholder="{{language}}"
          />
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'remove_label':
      return (
        <>
          <InputField
            label="Collection to Remove From"
            value={node.label || ''}
            onChange={v => onChange({ label: v })}
            placeholder="farmers-bihar"
          />
          <p className="text-[10px] text-gray-400">Removes this contact from the named collection (tag). No-op if they weren't a member.</p>
          <NextSelect label="Next Node" value={node.next} options={nodeOptions} onChange={v => onChange({ next: v })} />
        </>
      )

    case 'end':
      return (
        <TextArea label="Farewell Message (optional)" value={node.text || ''} onChange={v => onChange({ text: v })} placeholder="Thank you! Goodbye." />
      )

    default:
      return <p className="text-xs text-gray-400">Unknown node type</p>
  }
}

// Variables panel: click a chip to insert {{var}} into the last-focused field
// (captured on mousedown, before focus leaves).
function VariablesPanel({ flowNodes }: { flowNodes: FlowNode[] }) {
  const [contactFields, setContactFields] = useState<string[]>([])
  const [expanded, setExpanded]           = useState(true)
  const [search, setSearch]               = useState('')
  const lastFocused = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // Track the last-focused text input globally via focusin
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        const el = t as HTMLInputElement | HTMLTextAreaElement
        if (el.type === 'text' || el.tagName === 'TEXTAREA' || !el.type) {
          lastFocused.current = el
        }
      }
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [])

  useEffect(() => {
    apiFetch('/api/wa/contact-fields')
      .then(r => r.ok ? r.json() : { fields: [] })
      .then(d => setContactFields(Array.isArray(d.fields) ? d.fields : []))
      .catch(() => {})
  }, [])

  const locals = useMemoLocals(flowNodes)

  // Contact globals: built-ins + dynamic fields
  const globals: { name: string; source: string }[] = [
    { name: 'contact.name',  source: 'built-in' },
    { name: 'contact.wa_id', source: 'built-in' },
    ...contactFields.map(f => ({ name: `contact.${f}`, source: 'field' })),
  ]

  const filter = (s: string) => !search || s.toLowerCase().includes(search.toLowerCase())

  function insertAtCursor(varName: string) {
    const el = lastFocused.current
    if (!el) return
    const placeholder = `{{${varName}}}`
    const start = el.selectionStart ?? el.value.length
    const end   = el.selectionEnd   ?? el.value.length
    // Native setter so React's controlled input picks up the change
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const newValue = el.value.slice(0, start) + placeholder + el.value.slice(end)
    if (setter) setter.call(el, newValue)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    // Move caret to right after the inserted placeholder
    requestAnimationFrame(() => {
      const pos = start + placeholder.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="border-t border-gray-100 bg-purple-50/40 shrink-0">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2 text-[10px] font-bold text-purple-700 uppercase tracking-widest hover:bg-purple-50"
      >
        <span className="flex items-center gap-1.5">
          <span>📦 Variables</span>
          <span className="text-purple-400 font-normal normal-case tracking-normal">— click to insert</span>
        </span>
        <span className="text-purple-400">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <input
            className="w-full rounded-lg border border-purple-200 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-purple-300 bg-white"
            placeholder="Search variables…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <div>
            <div className="text-[9px] font-bold text-blue-700 uppercase tracking-widest mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> Local (this flow)
            </div>
            <div className="flex flex-wrap gap-1">
              {locals.filter(l => filter(l.name)).length === 0 && (
                <span className="text-[10px] text-gray-400 italic px-1">No saved variables yet. Use <em>save_as</em> on a question to define one.</span>
              )}
              {locals.filter(l => filter(l.name)).map(l => (
                <button
                  key={l.name}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); insertAtCursor(l.name) }}
                  title={`Defined by: ${l.source}`}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 transition font-mono"
                >
                  {`{{${l.name}}}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[9px] font-bold text-green-700 uppercase tracking-widest mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Global (contact-wide)
            </div>
            <div className="flex flex-wrap gap-1">
              {globals.filter(g => filter(g.name)).map(g => (
                <button
                  key={g.name}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); insertAtCursor(g.name) }}
                  title={g.source}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 transition font-mono"
                >
                  {`{{${g.name}}}`}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[9px] text-gray-500 pt-1">
            <strong>Local</strong> = lives only during this flow. <strong>Global</strong> = saved on the contact, readable from any future flow. Use <em>update_contact</em> to promote a local value to global.
          </div>
        </div>
      )}
    </div>
  )
}

// Every save_as / field in the flow becomes a local variable
function useMemoLocals(flowNodes: FlowNode[]): { name: string; source: string }[] {
  return (() => {
    const seen = new Set<string>()
    const out: { name: string; source: string }[] = []
    for (const n of flowNodes) {
      const saveAs = (n as any).save_as
      if (saveAs && !seen.has(saveAs)) {
        seen.add(saveAs)
        out.push({ name: saveAs, source: `${NODE_META[n.type]?.icon ?? ''} ${n.node_label || NODE_META[n.type]?.label || n.type}` })
      }
      if (n.type === 'set_field' && n.field && !seen.has(n.field)) {
        seen.add(n.field)
        out.push({ name: n.field, source: 'set_field' })
      }
    }
    return out
  })()
}

function InputField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">{label}</label>
      <input
        className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
        value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

function TextArea({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">{label}</label>
      <textarea
        rows={3}
        className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"
        value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
      />
      <p className="text-[9px] text-gray-400 mt-0.5">Use {'{{variable_name}}'} to insert collected data</p>
    </div>
  )
}

function SelectField({ label, value, options, onChange }: {
  label: string; value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">{label}</label>
      <select
        className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white"
        value={value} onChange={e => onChange(e.target.value)}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function NextSelect({ label, value, options, onChange }: {
  label: string; value?: string
  options: Array<{ id: string; label: string }>
  onChange: (v: string | undefined) => void
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">{label}</label>
      <select
        className="w-full rounded-xl border border-[#D9E6E8] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white"
        value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}
      >
        <option value="">— End / None —</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  )
}

function OptionList({ label, options, max, onChange, hasDescription }: {
  label: string; options: ListOption[]; max: number
  onChange: (opts: ListOption[]) => void; hasDescription?: boolean
}) {
  function update(idx: number, patch: Partial<ListOption>) {
    const u = [...options]; u[idx] = { ...u[idx], ...patch }; onChange(u)
  }
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">{label}</label>
      <div className="space-y-2">
        {options.map((opt, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1 space-y-1.5">
              <input
                className="w-full rounded-xl border border-[#D9E6E8] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                placeholder={`Option ${i + 1} title`} value={opt.title}
                onChange={e => update(i, { title: e.target.value })}
              />
              {hasDescription && (
                <input
                  className="w-full rounded-xl border border-[#D9E6E8] px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300"
                  placeholder="Description (optional)" value={opt.description || ''}
                  onChange={e => update(i, { description: e.target.value })}
                />
              )}
            </div>
            <button
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              className="mt-1 w-7 h-7 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      {options.length < max && (
        <button
          onClick={() => onChange([...options, { id: String(options.length + 1), title: '', description: '' }])}
          className="mt-2 flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 font-semibold transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add Option
        </button>
      )}
    </div>
  )
}

function ButtonList({ buttons, onChange }: {
  buttons: ButtonOption[]; onChange: (btns: ButtonOption[]) => void
}) {
  function update(idx: number, patch: Partial<ButtonOption>) {
    const u = [...buttons]; u[idx] = { ...u[idx], ...patch }; onChange(u)
  }
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Buttons (up to 3)</label>
      <div className="space-y-2">
        {buttons.map((btn, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="flex-1 rounded-xl border border-[#D9E6E8] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder={`Button ${i + 1} label`} value={btn.title} maxLength={20}
              onChange={e => update(i, { title: e.target.value })}
            />
            <span className="text-[10px] text-gray-400 shrink-0">{20 - btn.title.length}</span>
            <button
              onClick={() => onChange(buttons.filter((_, j) => j !== i))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50 transition shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      {buttons.length < 3 && (
        <button
          onClick={() => onChange([...buttons, { id: String(buttons.length + 1), title: '' }])}
          className="mt-2 flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 font-semibold transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add Button
        </button>
      )}
    </div>
  )
}

function KVEditor({ label, value, onChange, placeholder_k, placeholder_v }: {
  label: string; value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  placeholder_k: string; placeholder_v: string
}) {
  const entries = Object.entries(value)
  function update(idx: number, k: string, v: string) {
    const u = [...entries]; u[idx] = [k, v]
    onChange(Object.fromEntries(u.filter(([key]) => key)))
  }
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">{label}</label>
      <div className="space-y-1.5">
        {entries.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="flex-1 rounded-xl border border-[#D9E6E8] px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder={placeholder_k} value={k}
              onChange={e => update(i, e.target.value, v)}
            />
            <span className="text-gray-300 text-xs">:</span>
            <input
              className="flex-1 rounded-xl border border-[#D9E6E8] px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-purple-300"
              placeholder={placeholder_v} value={v}
              onChange={e => update(i, k, e.target.value)}
            />
            <button
              onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}
              className="w-6 h-6 rounded-lg flex items-center justify-center text-gray-300 hover:text-red-400 transition shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange({ ...value, '': '' })}
        className="mt-1.5 flex items-center gap-1.5 text-xs text-purple-600 hover:text-purple-800 font-semibold transition"
      >
        <Plus className="w-3 h-3" /> Add Entry
      </button>
    </div>
  )
}
