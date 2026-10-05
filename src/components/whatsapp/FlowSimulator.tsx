// Glific-style WhatsApp flow simulator in a draggable phone frame.

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  X, RotateCcw, Send, Phone, Video, MoreVertical,
  Search, Paperclip, Smile, Mic, CheckCheck, ChevronDown,
} from 'lucide-react'
import type { FlowNode, WaFlow, ListOption, ButtonOption } from '../../types/whatsapp'


type MsgFrom = 'bot' | 'user' | 'system'
type MsgKind = 'text' | 'list' | 'buttons' | 'system'

interface SimMsg {
  id:         number
  from:       MsgFrom
  kind:       MsgKind
  text:       string
  time:       string           // HH:MM
  options?:   ListOption[]
  buttons?:   ButtonOption[]
  selected?:  string          // after user picks
}

type WaitKind = null | 'text' | 'list' | 'buttons'

interface SimState {
  msgs:       SimMsg[]
  vars:       Record<string, string>
  nodeId:     string | null
  waitFor:    WaitKind
  done:       boolean
}


let _id = 1
const mid = () => _id++

function nowTime(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function interp(text: string, vars: Record<string, string>): string {
  // Supports both {{var}} and @contact.name / @results.var
  return text
    .replace(/\{\{([^}]+)\}\}/g, (_, k) => vars[k.trim()] ?? `{{${k.trim()}}}`)
    .replace(/@results\.(\w+)/g, (_, k) => vars[k] ?? `@results.${k}`)
    .replace(/@contact\.name/g, vars['contact_name'] ?? 'Contact')
}

function evalCond(node: FlowNode, vars: Record<string, string>): boolean {
  const raw = vars[node.variable || ''] ?? ''
  const val = node.value || ''
  switch (node.operator) {
    case 'equals':      return raw.toLowerCase() === val.toLowerCase()
    case 'contains':    return raw.toLowerCase().includes(val.toLowerCase())
    case 'starts_with': return raw.toLowerCase().startsWith(val.toLowerCase())
    case 'not_empty':   return raw.trim().length > 0
    case 'is_number':   return !isNaN(Number(raw)) && raw.trim() !== ''
    default:            return false
  }
}

function validateInput(text: string, kind?: 'text' | 'number' | 'phone' | 'image'): string | null {
  if (!text.trim()) return 'Please enter a value'
  if (kind === 'number' && isNaN(Number(text))) return 'Please enter a valid number'
  if (kind === 'phone' && !/^\+?[\d\s\-()]{7,}$/.test(text)) return 'Please enter a valid phone number'
  if (kind === 'image') return '📷 Please send a photo (image upload not supported in the simulator — try it on real WhatsApp)'
  return null
}

function mkBot(text: string, extra?: Partial<SimMsg>): SimMsg {
  return { id: mid(), from: 'bot', kind: 'text', text, time: nowTime(), ...extra }
}
function mkUser(text: string): SimMsg {
  return { id: mid(), from: 'user', kind: 'text', text, time: nowTime() }
}
function mkSys(text: string): SimMsg {
  return { id: mid(), from: 'system', kind: 'system', text, time: '' }
}


interface Props {
  flow:    WaFlow
  onClose: () => void
}


export function FlowSimulator({ flow, onClose }: Props) {
  const [state, setState]     = useState<SimState | null>(null)
  const [inputText, setInput] = useState('')
  const [inputErr, setErr]    = useState('')
  // List drawer state, separate from the chat state
  const [drawerMsgId, setDrawerMsgId] = useState<number | null>(null)

  const [pos, setPos]       = useState({ x: 0, y: 0 })
  const [dragging, setDrag] = useState(false)
  const dragOrigin          = useRef<{ mx: number; my: number; px: number; py: number } | null>(null)

  const scrollRef  = useRef<HTMLDivElement>(null)
  const nodeMapRef = useRef<Map<string, FlowNode>>(new Map())

  useEffect(() => {
    const m = new Map<string, FlowNode>()
    flow.nodes.forEach(n => m.set(n.id, n))
    nodeMapRef.current = m
  }, [flow.nodes])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [state?.msgs.length])

  // ── Engine ──

  const run = useCallback((
    nodeId: string | null | undefined,
    msgs:   SimMsg[],
    vars:   Record<string, string>,
  ): SimState => {
    if (!nodeId) return { msgs: [...msgs, mkSys('Flow ended — no next node')], vars, nodeId: null, waitFor: null, done: true }

    const node = nodeMapRef.current.get(nodeId)
    if (!node) return { msgs: [...msgs, mkSys(`⚠ Node "${nodeId}" not found`)], vars, nodeId: null, waitFor: null, done: true }

    switch (node.type) {

      case 'send_message':
        return run(node.next, [...msgs, mkBot(interp(node.text || '', vars))], vars)

      case 'send_list': {
        const header = node.header ? interp(node.header, vars) : ''
        const body   = interp(node.text || '', vars)
        const lines  = [header, body].filter(Boolean).join('\n')
        return {
          msgs: [...msgs, mkBot(lines, { kind: 'list', options: node.options || [] })],
          vars, nodeId, waitFor: 'list', done: false,
        }
      }

      case 'send_buttons': {
        return {
          msgs: [...msgs, mkBot(interp(node.text || '', vars), { kind: 'buttons', buttons: node.buttons || [] })],
          vars, nodeId, waitFor: 'buttons', done: false,
        }
      }

      case 'wait_input': {
        const prompt = mkBot(interp(node.text || '', vars))
        return { msgs: [...msgs, prompt], vars, nodeId, waitFor: 'text', done: false }
      }

      case 'condition': {
        const ok  = evalCond(node, vars)
        const lbl = ok ? '✅ TRUE' : '❌ FALSE'
        return run(ok ? node.next_true : node.next_false, [...msgs, mkSys(`${lbl} — if ${node.variable} ${node.operator} "${node.value}"`)], vars)
      }

      case 'set_field': {
        const k = node.field || '?'
        const v = interp(node.value || '', vars)
        return run(node.next, [...msgs, mkSys(`📌 ${k} = "${v}"`)], { ...vars, [k]: v })
      }

      case 'delay': {
        const secs = node.delay_seconds ?? 5
        return run(node.next, [...msgs, mkSys(`⏱ Wait ${secs}s (simulated instantly)`)], vars)
      }

      case 'add_label': {
        const lbl = node.label || '?'
        return run(node.next, [...msgs, mkSys(`🏷 Label added: ${lbl}`)], { ...vars, _labels: `${vars._labels ? vars._labels + ', ' : ''}${lbl}` })
      }

      case 'enter_flow': {
        const name = node.flow_name || '?'
        return { msgs: [...msgs, mkSys(`↗ Entering sub-flow: "${name}" (not loaded in simulator)`)], vars, nodeId: null, waitFor: null, done: true }
      }

      case 'webhook': {
        const newMsgs = [...msgs, mkSys(`🌐 Webhook → ${node.url || '?'} (simulated — empty response)`)]
        return run(node.next, newMsgs, vars)
      }

      case 'end': {
        const farewell = node.text?.trim()
        const endMsgs  = farewell
          ? [...msgs, mkBot(interp(farewell, vars)), mkSys('✅ Flow completed')]
          : [...msgs, mkSys('✅ Flow completed')]
        return { msgs: endMsgs, vars, nodeId: null, waitFor: null, done: true }
      }

      default:
        return { msgs: [...msgs, mkSys(`⚠ Unknown node: ${node.type}`)], vars, nodeId: null, waitFor: null, done: true }
    }
  }, [])


  function start() {
    _id = 1
    const first = flow.nodes[0]?.id
    if (!first) {
      setState({ msgs: [mkSys('⚠ This flow has no nodes')], vars: {}, nodeId: null, waitFor: null, done: true })
      return
    }
    setInput(''); setErr(''); setDrawerMsgId(null)
    setState(run(first, [mkSys(`Simulating: ${flow.name}`)], {}))
  }

  useEffect(() => { start() }, []) // eslint-disable-line react-hooks/exhaustive-deps


  function sendText() {
    if (!state || state.waitFor !== 'text' || !state.nodeId) return
    const text = inputText.trim()
    if (!text) { setErr('Please type something'); return }
    const node = nodeMapRef.current.get(state.nodeId)
    if (!node) return
    const err = validateInput(text, node.validation || 'text')
    if (err) { setErr(err); return }
    setErr('')
    const newVars = { ...state.vars, [node.save_as || 'response']: text }
    setState(run(node.next, [...state.msgs, mkUser(text)], newVars))
    setInput('')
  }

  function pickListItem(msgId: number, opt: ListOption) {
    if (!state || state.waitFor !== 'list' || !state.nodeId) return
    const node = nodeMapRef.current.get(state.nodeId)
    if (!node) return
    const newVars = { ...state.vars, [node.save_as || 'selection']: opt.title }
    const marked  = state.msgs.map(m => m.id === msgId ? { ...m, selected: opt.title } : m)
    setDrawerMsgId(null)
    setState(run(node.next, [...marked, mkUser(opt.title)], newVars))
  }

  function pickButton(msgId: number, btn: ButtonOption) {
    if (!state || state.waitFor !== 'buttons' || !state.nodeId) return
    const node = nodeMapRef.current.get(state.nodeId)
    if (!node) return
    const newVars = { ...state.vars, [node.save_as || 'choice']: btn.title }
    const marked  = state.msgs.map(m => m.id === msgId ? { ...m, selected: btn.title } : m)
    setState(run(node.next, [...marked, mkUser(btn.title)], newVars))
  }


  function onMouseDown(e: React.MouseEvent) {
    dragOrigin.current = { mx: e.clientX, my: e.clientY, px: pos.x, py: pos.y }
    setDrag(true)
  }
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging || !dragOrigin.current) return
      setPos({
        x: dragOrigin.current.px + (e.clientX - dragOrigin.current.mx),
        y: dragOrigin.current.py + (e.clientY - dragOrigin.current.my),
      })
    }
    function onUp() { setDrag(false); dragOrigin.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging])


  const vars      = state?.vars ?? {}
  const varKeys   = Object.keys(vars).filter(k => k !== '_labels')
  const labels    = vars._labels || ''


  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      <div
        className="fixed z-50 flex flex-col rounded-[40px] overflow-hidden shadow-2xl border-[8px] border-gray-800"
        style={{
          width: 320,
          height: 600,
          top:  '50%',
          left: '50%',
          transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
          background: '#ECE5DD',
          cursor: dragging ? 'grabbing' : 'default',
          userSelect: 'none',
        }}
      >

        <div
          className="flex items-center justify-between px-6 py-1 text-white text-[10px] font-semibold shrink-0"
          style={{ background: '#075E54' }}
        >
          <span>{new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
          <span className="flex gap-1 items-center">
            <span>●●●</span>
            <span>WiFi</span>
            <span>🔋</span>
          </span>
        </div>

        <div
          className="flex items-center gap-2.5 px-3 py-2 shrink-0 cursor-grab active:cursor-grabbing"
          style={{ background: '#075E54' }}
          onMouseDown={onMouseDown}
        >
          <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm shrink-0 select-none">
            🤖
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-white font-semibold text-sm leading-none truncate">{flow.name}</div>
            <div className="text-green-200 text-[10px] mt-0.5">
              {state?.done ? 'offline' : state?.waitFor ? 'online' : 'typing…'}
            </div>
          </div>
          <div className="flex items-center gap-2.5 text-white/80">
            <Video  className="w-4 h-4" />
            <Phone  className="w-4 h-4" />
            <Search className="w-4 h-4" />
            <MoreVertical className="w-4 h-4" />
          </div>
          <button
            onClick={e => { e.stopPropagation(); start() }}
            title="Restart"
            className="w-7 h-7 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 text-white transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onClose() }}
            className="w-7 h-7 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 text-white transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-2 py-2 space-y-1"
          style={{ background: '#ECE5DD' }}
        >
          {state?.msgs.map(msg => (
            <Bubble
              key={msg.id}
              msg={msg}
              onOpenDrawer={id => setDrawerMsgId(id)}
              onPickBtn={pickButton}
            />
          ))}
        </div>

        {(varKeys.length > 0 || labels) && (
          <div className="shrink-0 bg-white/80 backdrop-blur px-3 py-1.5 border-t border-[#D9E6E8]">
            {labels && (
              <p className="text-[9px] text-cyan-700 font-semibold truncate">🏷 {labels}</p>
            )}
            {varKeys.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-0.5">
                {varKeys.map(k => (
                  <span key={k} className="text-[9px] bg-purple-100 text-purple-700 rounded-full px-2 py-0.5 font-mono">
                    {k}={vars[k]}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="shrink-0 bg-[#F0F0F0] px-2 py-2">
          {state?.done ? (
            <button
              onClick={start}
              className="w-full py-2 rounded-full text-xs font-bold text-white flex items-center justify-center gap-2"
              style={{ background: '#075E54' }}
            >
              <RotateCcw className="w-3.5 h-3.5" /> Restart simulation
            </button>
          ) : state?.waitFor === 'text' ? (
            <div className="space-y-1">
              {inputErr && <p className="text-[10px] text-red-500 px-2">{inputErr}</p>}
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 bg-white rounded-full px-3 py-2 border border-[#D9E6E8]">
                  <Smile     className="w-4 h-4 text-gray-400 shrink-0" />
                  <input
                    autoFocus
                    className="flex-1 text-sm bg-transparent focus:outline-none text-gray-800 placeholder-gray-400"
                    placeholder="Type a message"
                    value={inputText}
                    onChange={e => { setInput(e.target.value); setErr('') }}
                    onKeyDown={e => { if (e.key === 'Enter') sendText() }}
                  />
                  <Paperclip className="w-4 h-4 text-gray-400 shrink-0" />
                </div>
                <button
                  onClick={sendText}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0 shadow"
                  style={{ background: '#075E54' }}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : state?.waitFor === 'list' || state?.waitFor === 'buttons' ? (
            <div className="flex items-center gap-2 bg-white rounded-full px-4 py-2.5 text-xs text-gray-400">
              <Mic className="w-4 h-4" />
              <span className="flex-1 text-center">Tap an option above</span>
              <Mic className="w-4 h-4 opacity-0" />
            </div>
          ) : (
            <div className="flex items-center gap-2 bg-white rounded-full px-4 py-2.5 text-xs text-gray-400">
              <Mic className="w-4 h-4" />
              <span className="flex-1 text-center">Processing…</span>
              <Mic className="w-4 h-4 opacity-0" />
            </div>
          )}
        </div>

      </div>

      {/* List drawer (bottom sheet) */}
      {drawerMsgId !== null && (() => {
        const msg = state?.msgs.find(m => m.id === drawerMsgId)
        if (!msg || msg.kind !== 'list') return null
        return (
          <ListDrawer
            msg={msg}
            onPick={opt => pickListItem(msg.id, opt)}
            onClose={() => setDrawerMsgId(null)}
          />
        )
      })()}
    </>
  )
}


function Bubble({
  msg, onOpenDrawer, onPickBtn,
}: {
  msg:          SimMsg
  onOpenDrawer: (id: number) => void
  onPickBtn:    (id: number, btn: ButtonOption) => void
}) {
  if (msg.kind === 'system') {
    return (
      <div className="flex justify-center my-1">
        <span className="text-[9px] text-gray-500 bg-white/60 rounded-full px-3 py-0.5 shadow-sm">
          {msg.text}
        </span>
      </div>
    )
  }

  if (msg.from === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[72%] bg-[#DCF8C6] rounded-2xl rounded-br-sm px-3 py-1.5 shadow-sm">
          <p className="text-sm text-gray-900 leading-snug">{msg.text}</p>
          <div className="flex items-center justify-end gap-1 mt-0.5">
            <span className="text-[9px] text-gray-400">{msg.time}</span>
            <CheckCheck className="w-3 h-3 text-[#53bdeb]" />
          </div>
        </div>
      </div>
    )
  }

  if (msg.kind === 'text') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[72%] bg-white rounded-2xl rounded-bl-sm px-3 py-1.5 shadow-sm">
          <p className="text-sm text-gray-900 leading-snug whitespace-pre-wrap">{msg.text}</p>
          <span className="text-[9px] text-gray-400 mt-0.5 block text-right">{msg.time}</span>
        </div>
      </div>
    )
  }

  if (msg.kind === 'list') {
    const done = !!msg.selected
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-white rounded-2xl rounded-bl-sm shadow-sm overflow-hidden">
          <div className="px-3 pt-2.5 pb-1">
            <p className="text-sm text-gray-900 whitespace-pre-wrap leading-snug">{msg.text}</p>
            <span className="text-[9px] text-gray-400 block text-right mt-0.5">{msg.time}</span>
          </div>
          <div className="border-t border-gray-100">
            {done ? (
              <div className="flex items-center justify-center gap-1.5 px-4 py-2 text-xs text-gray-400">
                <span>Selected: <strong className="text-gray-700">{msg.selected}</strong></span>
              </div>
            ) : (
              <button
                onClick={() => onOpenDrawer(msg.id)}
                className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-[#009688] hover:bg-gray-50 transition"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                View options
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (msg.kind === 'buttons') {
    const done = !!msg.selected
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-white rounded-2xl rounded-bl-sm shadow-sm overflow-hidden">
          <div className="px-3 pt-2.5 pb-1">
            <p className="text-sm text-gray-900 whitespace-pre-wrap leading-snug">{msg.text}</p>
            <span className="text-[9px] text-gray-400 block text-right mt-0.5">{msg.time}</span>
          </div>
          <div className="border-t border-gray-100 divide-y divide-gray-100">
            {(msg.buttons || []).map(btn => {
              const selected = msg.selected === btn.title
              return (
                <button
                  key={btn.id}
                  disabled={done}
                  onClick={() => !done && onPickBtn(msg.id, btn)}
                  className={`w-full py-2.5 px-4 text-xs font-semibold text-center transition ${
                    done
                      ? selected
                        ? 'bg-teal-50 text-teal-700'
                        : 'text-gray-300'
                      : 'text-[#009688] hover:bg-gray-50 active:bg-gray-100'
                  }`}
                >
                  {btn.title}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  return null
}


function ListDrawer({
  msg, onPick, onClose,
}: {
  msg:     SimMsg
  onPick:  (opt: ListOption) => void
  onClose: () => void
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-[55] bg-black/40"
        onClick={onClose}
      />
      {/* Anchored to the bottom of the phone frame */}
      <div
        className="fixed z-[60] bg-white rounded-t-3xl shadow-2xl overflow-hidden"
        style={{
          bottom: '50%',
          left:   '50%',
          transform: 'translateX(-50%) translateY(50%)',
          width:  304,
          maxHeight: 420,
          marginTop: 80,
        }}
      >
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-gray-300" />
        </div>
        <div className="px-4 pb-2">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Select an option</p>
        </div>
        <div className="overflow-y-auto max-h-72 divide-y divide-gray-50">
          {(msg.options || []).map(opt => (
            <button
              key={opt.id}
              onClick={() => onPick(opt)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left transition"
            >
              <div className="w-4 h-4 rounded-full border-2 border-[#009688] shrink-0" />
              <div>
                <div className="text-sm font-semibold text-gray-800">{opt.title}</div>
                {opt.description && (
                  <div className="text-[10px] text-gray-400 mt-0.5">{opt.description}</div>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="border-t border-gray-100 px-4 py-3">
          <button
            onClick={onClose}
            className="w-full py-2 text-xs font-semibold text-gray-500 hover:text-gray-700 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}
