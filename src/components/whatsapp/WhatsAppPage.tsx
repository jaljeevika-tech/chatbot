// WhatsApp platform page: Overview
// Flows
// Contacts
// Broadcast
// Settings.

import { useState, useEffect } from 'react'
import {
  MessageSquare, Users, Send, Settings, BarChart2, BarChart3, Layers,
  TrendingUp, CheckCircle2, Loader2, AlertTriangle, MessagesSquare,
} from 'lucide-react'
import type { WaStats } from '../../types/whatsapp'
import { FF }                from '../../theme/colors'
import { apiFetch }          from '../../utils/apiFetch'
import { FlowList }          from './FlowList'
import { ContactsList }      from './ContactsList'
import { BroadcastPanel }    from './BroadcastPanel'
import { WaSettings }        from './WaSettings'
import { ConversationsTab }  from './ConversationsTab'
import { AnalyticsTab }      from './AnalyticsTab'
import { CollectionsTab }    from './CollectionsTab'

type Tab = 'overview' | 'conversations' | 'flows' | 'contacts' | 'collections' | 'broadcast' | 'analytics' | 'settings'

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'overview',       label: 'Overview',       icon: BarChart2       },
  { key: 'conversations',  label: 'Conversations',  icon: MessagesSquare  },
  { key: 'flows',          label: 'Flows',          icon: MessageSquare   },
  { key: 'contacts',       label: 'Contacts',       icon: Users           },
  { key: 'collections',    label: 'Collections',    icon: Layers          },
  { key: 'broadcast',      label: 'Broadcast',      icon: Send            },
  { key: 'analytics',      label: 'Analytics',      icon: BarChart3       },
  { key: 'settings',       label: 'Settings',       icon: Settings        },
]

export function WhatsAppPage() {
  const [tab, setTab]     = useState<Tab>('overview')
  const [stats, setStats] = useState<WaStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(true)
  const [configOk, setConfigOk]   = useState<boolean | null>(null)

  useEffect(() => {
    apiFetch('/api/wa/stats')
      .then(r => r.json())
      .then(d => { setStats(d); setConfigOk(true) })
      .catch(() => setConfigOk(false))
      .finally(() => setLoadingStats(false))
  }, [])

  return (
    <div className="flex flex-col h-full min-h-0">

      <div className="shrink-0 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: '#25D366' }}>
            <WhatsAppIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="font-serif font-semibold text-gray-900 text-lg leading-none">WhatsApp Platform</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Powered by Meta WhatsApp Cloud API
            </p>
          </div>
          {configOk === false && (
            <div className="ml-auto flex items-center gap-1.5 text-amber-600 text-xs font-semibold bg-amber-50 border border-amber-200 rounded-xl px-3 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Not configured — go to Settings
            </div>
          )}
          {configOk === true && (
            <div className="ml-auto flex items-center gap-1.5 text-green-600 text-xs font-semibold bg-green-50 border border-green-200 rounded-xl px-3 py-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Connected
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 flex gap-1.5 mb-4 overflow-x-auto pb-1 no-scrollbar">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all"
            style={{
              background: tab === key ? '#341272' : 'transparent',
              color:      tab === key ? '#fff'    : FF.textMuted,
              border:     tab === key ? 'none'    : `1.5px solid ${FF.border}`,
            }}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'overview'      && <OverviewTab stats={stats} loading={loadingStats} onNavigate={setTab} />}
        {tab === 'conversations' && <div className="h-full flex flex-col"><ConversationsTab /></div>}
        {tab === 'flows'         && <FlowList />}
        {tab === 'contacts'      && <div className="h-full flex flex-col"><ContactsList /></div>}
        {tab === 'collections'   && <CollectionsTab />}
        {tab === 'broadcast'     && <BroadcastPanel />}
        {tab === 'analytics'     && <AnalyticsTab />}
        {tab === 'settings'      && <WaSettings />}
      </div>
    </div>
  )
}

function OverviewTab({ stats, loading, onNavigate }: {
  stats:      WaStats | null
  loading:    boolean
  onNavigate: (tab: Tab) => void
}) {
  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
    </div>
  )

  const cards = [
    { label: 'Contacts',           value: stats?.contacts          ?? 0, icon: Users,        color: '#8B5CF6', bg: '#F5F3FF', nav: 'contacts' as Tab },
    { label: 'Inbound Messages',   value: stats?.inboundMessages   ?? 0, icon: MessageSquare, color: '#3B82F6', bg: '#EFF6FF', nav: null },
    { label: 'Outbound Messages',  value: stats?.outboundMessages  ?? 0, icon: Send,         color: '#10B981', bg: '#ECFDF5', nav: null },
    { label: 'Active Flows',       value: stats?.activeFlows       ?? 0, icon: CheckCircle2, color: '#F59E0B', bg: '#FFFBEB', nav: 'flows' as Tab },
    { label: 'Active Sessions',    value: stats?.activeSessions    ?? 0, icon: TrendingUp,   color: '#EC4899', bg: '#FDF2F8', nav: null },
    { label: 'Completed Sessions', value: stats?.completedSessions ?? 0, icon: BarChart2,    color: '#6366F1', bg: '#EEF2FF', nav: null },
  ]

  return (
    <div className="space-y-5">

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cards.map(card => (
          <button
            key={card.label}
            onClick={() => card.nav && onNavigate(card.nav)}
            disabled={!card.nav}
            className={`rounded-xl p-4 text-left transition-all ${card.nav ? 'hover:shadow-md cursor-pointer' : 'cursor-default'}`}
            style={{ background: card.bg }}
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center mb-3"
              style={{ background: card.color + '22' }}
            >
              <card.icon className="w-4 h-4" style={{ color: card.color }} />
            </div>
            <div className="text-2xl font-serif font-semibold text-gray-900">
              {card.value.toLocaleString('en-IN')}
            </div>
            <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide mt-0.5">
              {card.label}
            </div>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl p-5" style={{ border: `1px solid ${FF.border}` }}>
        <h3 className="font-bold text-gray-900 mb-4 text-sm">Quick Actions</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: '💬', label: 'Conversations',  desc: 'Chat with contacts',   nav: 'conversations' as Tab },
            { icon: '🤖', label: 'Create Flow',    desc: 'Build a chatbot flow', nav: 'flows' as Tab },
            { icon: '📢', label: 'Broadcast',      desc: 'Message all contacts', nav: 'broadcast' as Tab },
            { icon: '⚙️', label: 'Configure API',  desc: 'Setup credentials',    nav: 'settings' as Tab },
          ].map(a => (
            <button
              key={a.label}
              onClick={() => onNavigate(a.nav)}
              className="p-4 rounded-xl hover:border-purple-200 hover:bg-purple-50 text-left transition-all"
              style={{ border: `1px solid ${FF.border}` }}
            >
              <div className="text-2xl mb-2">{a.icon}</div>
              <div className="text-sm font-bold text-gray-800">{a.label}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{a.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl p-5" style={{ border: `1px solid ${FF.border}` }}>
        <h3 className="font-bold text-gray-900 mb-4 text-sm">How It Works</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { step: '1', icon: '📱', title: 'Contact messages you', desc: 'When someone sends a keyword trigger to your WhatsApp number, a flow starts automatically.' },
            { step: '2', icon: '🤖', title: 'Flow runs automatically', desc: 'The bot guides them through your configured nodes — messages, lists, buttons, and input forms.' },
            { step: '3', icon: '📊', title: 'Data is collected', desc: 'All responses are saved to contact fields. Use webhooks to forward data to your backend.' },
          ].map(s => (
            <div key={s.step} className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-purple-100 text-purple-700 text-xs font-black flex items-center justify-center shrink-0">
                {s.step}
              </div>
              <div>
                <div className="text-sm font-bold text-gray-800">{s.icon} {s.title}</div>
                <div className="text-xs text-gray-500 mt-1 leading-relaxed">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
    </svg>
  )
}
