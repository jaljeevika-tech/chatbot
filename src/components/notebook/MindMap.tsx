// "Mind Map" output tab: an SVG topic tree from the sources; clicking a node asks Chat
// a follow-up about that topic.

import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../../utils/apiFetch'
import { Network, Loader2, AlertCircle, Download, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import type { NotebookSource, MindMapNode, MindMapOutputData } from '../../types/notebook'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF', sidebar: '#341272' }

/** Strip trailing commas / literal newlines the model sometimes leaves inside strings, like the sibling SlideDeck/StudyGuide parsers. */
function cleanJSON(s: string): string {
  let out = '', inStr = false, escaped = false
  for (const ch of s) {
    if (escaped)              { out += ch; escaped = false; continue }
    if (ch === '\\')          { out += ch; escaped = true;  continue }
    if (ch === '"')           { inStr = !inStr; out += ch;  continue }
    if (inStr && ch === '\n') { out += '\\n'; continue }
    if (inStr && ch === '\r') { out += '\\r'; continue }
    if (inStr && ch === '\t') { out += '\\t'; continue }
    out += ch
  }
  return out
}

async function streamSSE(url: string, body: object): Promise<string> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.body) throw new Error('No stream')
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    try { const j = JSON.parse(errBody); throw new Error(j.error || `HTTP ${res.status}`) }
    catch (e2) { if (e2 instanceof SyntaxError) throw new Error(`HTTP ${res.status}`); throw e2 }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let accum = '', buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const raw = trimmed.slice(6).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const chunk = JSON.parse(raw)
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.text) accum += chunk.text
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
  return accum
}

interface Positioned extends MindMapNode {
  x: number
  y: number
  children: Positioned[]
}

const COL_WIDTH  = 220
const ROW_HEIGHT = 56

function assignPositions(node: MindMapNode, depth: number, counter: { i: number }): Positioned {
  if (!node.children || node.children.length === 0) {
    const y = counter.i * ROW_HEIGHT
    counter.i++
    return { ...node, children: [], x: depth * COL_WIDTH, y }
  }
  const children = node.children.map(c => assignPositions(c, depth + 1, counter))
  const y = (children[0].y + children[children.length - 1].y) / 2
  return { ...node, children, x: depth * COL_WIDTH, y }
}

function maxDepth(node: MindMapNode): number {
  if (!node.children || node.children.length === 0) return 1
  return 1 + Math.max(...node.children.map(maxDepth))
}

function flatten(node: Positioned): Positioned[] {
  return [node, ...node.children.flatMap(flatten)]
}

interface Props {
  sources: NotebookSource[]
  onAskQuestion: (question: string) => void
  /** Saved tree, restored on notebook load. */
  initial?: MindMapOutputData
  onChange?: (data: MindMapOutputData) => void
  /** Reported up so OutputPanel can show a spinner and keep this tab mounted. */
  onBusyChange?: (busy: boolean) => void
}

export function MindMap({ sources, onAskQuestion, initial, onChange, onBusyChange }: Props) {
  const [tree, setTree]       = useState<MindMapNode | null>(initial?.tree ?? null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { onBusyChange?.(loading) }, [loading, onBusyChange])
  const [error, setError]     = useState<string | null>(null)
  const [showPrompt, setShowPrompt]     = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const svgRef = useRef<SVGSVGElement>(null)

  async function generate() {
    if (sources.length === 0) return
    setLoading(true); setError(null); setTree(null)
    try {
      const accum = await streamSSE('/api/notebook/mindmap', {
        sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 40_000) })),
        customPrompt,
      })
      const jsonMatch = accum.match(/\{[\s\S]*\}/)
      if (!jsonMatch) { setError('Could not parse mind map. Try generating again.'); return }
      const parsedTree = JSON.parse(cleanJSON(jsonMatch[0])) as MindMapNode
      setTree(parsedTree)
      onChange?.({ tree: parsedTree })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  /** Rasterizes the live SVG (incl. foreignObject labels) to PNG via an offscreen canvas. */
  function downloadPng() {
    const svgEl = svgRef.current
    if (!svgEl) return
    const svgData = new XMLSerializer().serializeToString(svgEl)
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    const img = new Image()
    img.onload = () => {
      const scale  = 2
      const canvas = document.createElement('canvas')
      canvas.width  = width * scale
      canvas.height = (height + 20) * scale
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.scale(scale, scale)
        ctx.drawImage(img, 0, 0)
      }
      URL.revokeObjectURL(url)
      canvas.toBlob(blob => {
        if (!blob) return
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'mind-map.png' })
        a.click()
        URL.revokeObjectURL(a.href)
      })
    }
    img.onerror = () => { URL.revokeObjectURL(url); setError('Could not export mind map as an image.') }
    img.src = url
  }

  const positioned = useMemo(() => tree ? assignPositions(tree, 0, { i: 0 }) : null, [tree])
  const allNodes    = useMemo(() => positioned ? flatten(positioned) : [], [positioned])
  const depth       = useMemo(() => tree ? maxDepth(tree) : 1, [tree])
  const height      = Math.max(200, allNodes.filter(n => n.children.length === 0).length * ROW_HEIGHT)
  const width       = depth * COL_WIDTH + 40

  function edges(node: Positioned): { from: Positioned; to: Positioned }[] {
    return node.children.flatMap(c => [{ from: node, to: c }, ...edges(c)])
  }

  const noSources = sources.length === 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
        <button
          onClick={() => setShowPrompt(v => !v)}
          className="w-full flex items-center gap-1.5 mb-2 text-[11px] font-semibold transition-all"
          style={{ color: showPrompt ? C.dark : '#86A0A5' }}
        >
          <Sparkles className="w-3 h-3" />
          Custom instructions
          {showPrompt ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
        </button>
        {showPrompt && (
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            placeholder="Focus the map on a specific theme, or ask for a particular structure…"
            rows={3}
            className="w-full text-[11px] rounded-xl px-3 py-2 mb-2 resize-none outline-none"
            style={{ background: C.bg, color: '#374151', border: '1.5px solid #D9E6E8' }}
          />
        )}

        <div className="flex gap-2">
          <SubscriptionGate featureName="AI Mind Map">
            <button
              onClick={generate}
              disabled={loading || noSources}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all"
              style={{
                background: noSources || loading ? '#D9E6E8' : C.dark,
                color:      noSources || loading ? '#86A0A5' : C.white,
              }}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Network className="w-3.5 h-3.5" />}
              {loading ? 'Mapping...' : tree ? 'Regenerate mind map' : 'Generate mind map'}
            </button>
          </SubscriptionGate>
          {tree && (
            <button
              onClick={downloadPng}
              title="Download as PNG"
              className="px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5"
              style={{ background: C.bg, color: C.dark, border: '1.5px solid #D9E6E8' }}
            >
              <Download className="w-3.5 h-3.5" />
              PNG
            </button>
          )}
        </div>
        {error && (
          <p className="mt-2 text-[11px] flex items-center gap-1" style={{ color: '#DC2626' }}>
            <AlertCircle className="w-3 h-3 shrink-0" />{error}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!positioned ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <Network className="w-8 h-8" style={{ color: C.lime }} />
            <p className="text-xs font-semibold" style={{ color: C.dark }}>Mind Map</p>
            <p className="text-[11px]" style={{ color: '#86A0A5' }}>
              {noSources ? 'Add sources first' : 'Generate a visual map of the key topics'}
            </p>
          </div>
        ) : (
          <svg ref={svgRef} width={width} height={height + 20} style={{ minWidth: '100%' }}>
            <g transform="translate(10, 10)">
              {edges(positioned).map((e, i) => {
                const midX = (e.from.x + e.to.x) / 2
                return (
                  <path
                    key={i}
                    d={`M ${e.from.x + 90} ${e.from.y + 18} C ${midX} ${e.from.y + 18}, ${midX} ${e.to.y + 18}, ${e.to.x} ${e.to.y + 18}`}
                    fill="none"
                    stroke="#D9E6E8"
                    strokeWidth={1.5}
                  />
                )
              })}
              {allNodes.map((n, i) => {
                const isRoot = n === positioned
                const isLeaf = n.children.length === 0
                return (
                  <g
                    key={i}
                    transform={`translate(${n.x}, ${n.y})`}
                    className="cursor-pointer"
                    onClick={() => onAskQuestion(`Tell me more about ${n.label}`)}
                  >
                    <rect
                      width={isRoot ? 180 : 172}
                      height={36}
                      rx={12}
                      fill={isRoot ? C.sidebar : isLeaf ? C.white : C.bg}
                      stroke={isLeaf ? '#D9E6E8' : 'none'}
                      strokeWidth={1}
                    />
                    <foreignObject width={isRoot ? 180 : 172} height={36}>
                      <div
                        className="w-full h-full flex items-center px-3 text-[11px] font-semibold leading-tight"
                        style={{ color: isRoot ? C.white : C.dark }}
                        title={n.label}
                      >
                        <span className="line-clamp-2">{n.label}</span>
                      </div>
                    </foreignObject>
                  </g>
                )
              })}
            </g>
          </svg>
        )}
      </div>
    </div>
  )
}
