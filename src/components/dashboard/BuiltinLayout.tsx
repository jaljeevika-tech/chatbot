// Per-org layouts for the built-in dashboards (services/dashboard/src/custom.js BUILTINS).
//
// A page wraps each of its sections in <Panel id>. With no saved layout (the
// default, and for non-editors) <BuiltinLayout> renders its children exactly as
// before. With one, it shows only the listed panels, in the saved order and width,
// with the super admin's catalog widgets in between.

import { Children, Fragment, isValidElement, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { apiFetch } from '../../utils/apiFetch'
import { WidgetView, type Widget, type WidgetData } from './CustomDashboardPage'

export type BuiltinKey = 'orgdash' | 'project' | 'impact' | 'beneficiaries'
export interface PanelWidget { id: string; chart: 'panel'; panel: string; title: string; wide: boolean }
export type LayoutWidget = Widget | PanelWidget
export const isPanel = (w: LayoutWidget): w is PanelWidget => w.chart === 'panel'

/** Marks one section of a built-in dashboard; `id` must match a BUILTINS panel key. */
export function Panel({ children }: { id: string; children?: ReactNode }) {
  return <>{children}</>
}

// Panels may sit inside plain layout wrappers (e.g. a two-column grid div), so
// look through intrinsic elements and fragments — never into components.
function collectPanels(node: ReactNode, out: Map<string, ReactNode>) {
  Children.forEach(node, el => {
    if (!isValidElement(el)) return
    const e = el as ReactElement<{ id?: string; children?: ReactNode }>
    if (e.type === Panel) out.set(e.props.id!, e.props.children)
    else if (typeof e.type === 'string' || e.type === Fragment) collectPanels(e.props.children, out)
  })
}

export function BuiltinLayout({ dash, projectKey, className, style, children }: {
  dash: BuiltinKey; projectKey?: string; className?: string; style?: CSSProperties; children: ReactNode
}) {
  const [layout, setLayout] = useState<{ widgets: LayoutWidget[] | null; data?: Record<string, WidgetData> } | null>(null)

  useEffect(() => {
    let cancelled = false
    // ponytail: shipped layout shows until this answers (a brief reorder if customised); cache per org if it's noticeable.
    apiFetch(`/api/builtin-dashboards/${dash}${projectKey ? `?project=${encodeURIComponent(projectKey)}` : ''}`)
      .then(r => (r.ok ? r.json() : null))
      .then(l => { if (!cancelled) setLayout(l) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dash, projectKey])

  if (!layout?.widgets) return <div className={className} style={style}>{children}</div>

  const panels = new Map<string, ReactNode>()
  collectPanels(children, panels)
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
      {layout.widgets.map(w => isPanel(w)
        ? panels.get(w.panel) ? <div key={w.id} className={`min-w-0 ${w.wide ? 'md:col-span-2' : ''}`}>{panels.get(w.panel)}</div> : null
        : <WidgetView key={w.id} widget={w} data={layout.data?.[w.id]} />)}
    </div>
  )
}
