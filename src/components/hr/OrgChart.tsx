// Lazy-loaded React Flow org chart from users.manager_id. People with neither a manager
// nor reports share one collapsible card so an org without reporting lines isn't one huge row.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FF } from '../../theme/colors'
import type { OrgPerson } from '../../types/hr'
import { STATUS } from './orgStatus'

const W = 210, H = 92, GAP_X = 22, GAP_Y = 64, GRID_COLS = 6
const LONERS = '__no_line__'

type PersonData = { p: OrgPerson; direct: number; total: number; expanded: boolean; hit: boolean; onToggle: (id: string) => void }
type GroupData = { count: number; expanded: boolean; onToggle: (id: string) => void }

function PersonNode({ data }: NodeProps<Node<PersonData>>) {
  const { p, direct, total, expanded, hit, onToggle } = data
  const st = p.status ? STATUS[p.status] : null
  return (
    <div
      role="button" tabIndex={0} aria-expanded={direct ? expanded : undefined}
      aria-label={`${p.name}${direct ? `, ${direct} direct reports` : ''}`}
      onClick={() => direct && onToggle(p.id)}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && direct) { e.preventDefault(); onToggle(p.id) } }}
      style={{
        width: W, height: H, background: '#FFFFFF', borderRadius: 10, padding: '9px 11px', boxSizing: 'border-box',
        border: `${hit ? 2 : 1}px solid ${hit ? FF.purple : FF.border}`, cursor: direct ? 'pointer' : 'default',
        boxShadow: hit ? '0 0 0 4px rgba(52,18,114,0.15)' : '0 1px 2px rgba(14,58,70,0.06)', fontFamily: "'IBM Plex Sans',sans-serif",
      }}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
      <div className="flex items-center gap-1.5">
        {st && <span title={st.label} style={{ width: 9, height: 9, borderRadius: 9, background: st.color, flexShrink: 0 }} />}
        <span style={{ fontSize: 13.5, fontWeight: 600, color: FF.tealDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
        {p.isHr && <span style={{ fontSize: 9.5, fontWeight: 700, color: FF.purple, background: '#EAE4F5', borderRadius: 4, padding: '1px 4px' }}>HR</span>}
      </div>
      <div style={{ fontSize: 11.5, color: FF.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.designation || p.role}{p.location ? ` · ${p.location}` : ''}
      </div>
      {direct > 0 && (
        <div style={{ fontSize: 11, color: FF.purple, marginTop: 6, fontWeight: 500 }}>
          {expanded ? '▾' : '▸'} {direct} direct{total > direct ? ` · ${total} in team` : ''}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
    </div>
  )
}

function GroupNode({ id, data }: NodeProps<Node<GroupData>>) {
  return (
    <div role="button" tabIndex={0} aria-expanded={data.expanded} onClick={() => data.onToggle(id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); data.onToggle(id) } }}
      style={{
        width: W, height: H, background: FF.bg, border: `1px dashed ${FF.textFaint}`, borderRadius: 10, padding: '10px 12px',
        boxSizing: 'border-box', cursor: 'pointer', fontFamily: "'IBM Plex Sans',sans-serif",
      }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: FF.tealDark }}>No reporting line set</div>
      <div style={{ fontSize: 11.5, color: FF.textMuted, marginTop: 2 }}>{data.count} people · set managers in HR Settings</div>
      <div style={{ fontSize: 11, color: FF.purple, marginTop: 6, fontWeight: 500 }}>{data.expanded ? '▾ Hide' : '▸ Show'}</div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} isConnectable={false} />
    </div>
  )
}

const nodeTypes = { person: PersonNode, group: GroupNode }

function Chart({ people, search }: { people: OrgPerson[]; search: string }) {
  const flow = useReactFlow()
  const { kids, roots, loners, byId, total } = useMemo(() => {
    const byId = new Map(people.map(p => [p.id, p]))
    const kids = new Map<string, string[]>()
    for (const p of people) {
      if (p.managerId && byId.has(p.managerId)) kids.set(p.managerId, [...(kids.get(p.managerId) || []), p.id])
    }
    const top = people.filter(p => !p.managerId || !byId.has(p.managerId))
    const roots = top.filter(p => kids.has(p.id)).map(p => p.id)
    const loners = top.filter(p => !kids.has(p.id)).map(p => p.id)
    const total = new Map<string, number>()
    const count = (id: string): number => {
      if (total.has(id)) return total.get(id)!
      total.set(id, 0)   // guards against a cycle in the data
      const n = (kids.get(id) || []).reduce((s, k) => s + 1 + count(k), 0)
      total.set(id, n)
      return n
    }
    people.forEach(p => count(p.id))
    return { kids, roots, loners, byId, total }
  }, [people])

  // Open the top two levels to start with.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(roots))
  const toggle = useCallback((id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  const q = search.trim().toLowerCase()
  const hit = q ? people.find(p => p.name.toLowerCase().includes(q)) ?? null : null

  // Searching opens the path down to the person.
  useEffect(() => {
    if (!hit) return
    setExpanded(prev => {
      const next = new Set(prev)
      let cur = hit.managerId && byId.get(hit.managerId)
      const seen = new Set<string>()
      while (cur && !seen.has(cur.id)) { seen.add(cur.id); next.add(cur.id); cur = cur.managerId ? byId.get(cur.managerId) : undefined }
      if (loners.includes(hit.id)) next.add(LONERS)
      return next
    })
  }, [hit, byId, loners])

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []
    const widthOf = (id: string, seen = new Set<string>()): number => {
      const ch = expanded.has(id) && !seen.has(id) ? kids.get(id) || [] : []
      if (!ch.length) return W
      seen.add(id)
      return Math.max(W, ch.reduce((s, c) => s + widthOf(c, seen), 0) + GAP_X * (ch.length - 1))
    }
    const place = (id: string, x: number, depth: number, seen = new Set<string>()) => {
      const w = widthOf(id)
      const p = byId.get(id)!
      const y = depth * (H + GAP_Y)
      nodes.push({ id, type: 'person', position: { x: x + (w - W) / 2, y }, draggable: false,
        data: { p, direct: kids.get(id)?.length ?? 0, total: total.get(id) ?? 0, expanded: expanded.has(id), hit: hit?.id === id, onToggle: toggle } })
      if (!expanded.has(id) || seen.has(id)) return
      seen.add(id)
      let cx = x
      for (const c of kids.get(id) || []) {
        edges.push({ id: `${id}-${c}`, source: id, target: c, type: 'smoothstep', style: { stroke: FF.textFaint } })
        place(c, cx, depth + 1, seen)
        cx += widthOf(c) + GAP_X
      }
    }
    let x = 0
    for (const r of roots) { place(r, x, 0); x += widthOf(r) + GAP_X * 3 }
    if (loners.length) {
      nodes.push({ id: LONERS, type: 'group', position: { x, y: 0 }, draggable: false,
        data: { count: loners.length, expanded: expanded.has(LONERS), onToggle: toggle } })
      if (expanded.has(LONERS)) {
        loners.forEach((id, i) => {
          const col = i % GRID_COLS, row = Math.floor(i / GRID_COLS)
          nodes.push({ id, type: 'person', draggable: false,
            position: { x: x + col * (W + GAP_X), y: (row + 1) * (H + GAP_Y / 2) + GAP_Y / 2 },
            data: { p: byId.get(id)!, direct: 0, total: 0, expanded: false, hit: hit?.id === id, onToggle: toggle } })
        })
      }
    }
    return { nodes, edges }
  }, [roots, loners, kids, byId, total, expanded, hit, toggle])

  // Centre on the search hit once it's laid out.
  useEffect(() => {
    if (!hit) return
    const n = nodes.find(nd => nd.id === hit.id)
    if (n) flow.setCenter(n.position.x + W / 2, n.position.y + H / 2, { zoom: 1, duration: 400 })
  }, [hit, nodes, flow])

  return (
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.1} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
      proOptions={{ hideAttribution: true }}>
      <Background color={FF.borderSoft} gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export default function OrgChart({ people, search }: { people: OrgPerson[]; search: string }) {
  return (
    <div style={{ height: '70vh', minHeight: 420, border: `1px solid ${FF.border}`, borderRadius: 12, overflow: 'hidden', background: '#FFFFFF' }}>
      <ReactFlowProvider><Chart people={people} search={search} /></ReactFlowProvider>
    </div>
  )
}
