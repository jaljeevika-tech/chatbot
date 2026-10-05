/** Per-user override of role-based tab and Content Hub access. */

import { useState } from 'react'
import { X, Save, RotateCcw, Loader2, CheckCircle2, LayoutGrid, ShieldCheck } from 'lucide-react'
import { useOrg } from '../../context/OrgContext'
import { useLanguage } from '../../context/LanguageContext'
import { apiFetch } from '../../utils/apiFetch'
import { TAB_DEFS, DEFAULT_TAB_PERMISSIONS } from './TabAccessSettings'
import type { TabPermMap } from './TabAccessSettings'
import { DEFAULT_PERMISSIONS, getContentTypes } from './contentHubTypes'
import type { PermissionsMap } from './ContentHubSettings'
import type { UserRow } from '../../utils/authSheet'

const C = { sidebar: '#341272', surface: '#EDE8F9' }

function normalise(p: string) {
  const c = String(p || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
  return c.length === 10 ? '91' + c : c
}

/** What an un-overridden manager/employee sees via their role-based perms */
function roleDefaultTabs(role: string, orgTabPerms: TabPermMap): string[] {
  return TAB_DEFS
    .filter(td => {
      const allowed = (orgTabPerms[td.key] as string[] | undefined) ?? (DEFAULT_TAB_PERMISSIONS[td.key] as string[]) ?? ['admin']
      return allowed.includes(role)
    })
    .map(td => td.key)
}

function roleDefaultContent(role: string, orgChPerms: PermissionsMap, allIds: string[]): string[] {
  return allIds.filter(id => {
    const allowed = orgChPerms[id] ?? DEFAULT_PERMISSIONS[id] ?? ['admin']
    return (allowed as string[]).includes(role)
  })
}

interface Props {
  user: UserRow
  orgTabPerms: TabPermMap
  orgChPerms:  PermissionsMap
  onClose: () => void
}

type Panel = 'tabs' | 'content'

export function UserAccessModal({ user, orgTabPerms, orgChPerms, onClose }: Props) {
  const { org, firebaseToken, loadOrg } = useOrg()
  const { t } = useLanguage()

  const phone = normalise(user.phone)
  const role  = (user.role?.toLowerCase() ?? 'employee') as string

  // Social has its own key (_social)
  const allContentTypes = getContentTypes(t).filter(ct => ct.category !== 'social')
  const allContentIds   = [...allContentTypes.map(ct => ct.id), '_social']

  // Per-user overrides; null means role defaults
  const existingTabOverride = (org?.userTabPermissions?.[phone] as string[] | undefined) ?? null
  const existingChOverride  = (org?.userContentHubPermissions?.[phone] as string[] | undefined) ?? null

  const [tabAccess,     setTabAccess]     = useState<Set<string>>(
    () => new Set(existingTabOverride ?? roleDefaultTabs(role, orgTabPerms))
  )
  const [chAccess,      setChAccess]      = useState<Set<string>>(
    () => new Set(existingChOverride ?? roleDefaultContent(role, orgChPerms, allContentIds))
  )
  const [hasTabOverride,  setHasTabOverride]  = useState(existingTabOverride !== null)
  const [hasChOverride,   setHasChOverride]   = useState(existingChOverride  !== null)

  const [panel,   setPanel]   = useState<Panel>('tabs')
  const [saving,  setSaving]  = useState(false)
  const [success, setSuccess] = useState(false)
  const [error,   setError]   = useState('')

  function toggleTab(key: string) {
    setTabAccess(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
    setHasTabOverride(true)
  }

  function toggleCh(id: string) {
    setChAccess(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
    setHasChOverride(true)
  }

  function resetTabs() {
    setTabAccess(new Set(roleDefaultTabs(role, orgTabPerms)))
    setHasTabOverride(false)
  }

  function resetCh() {
    setChAccess(new Set(roleDefaultContent(role, orgChPerms, allContentIds)))
    setHasChOverride(false)
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const body: Record<string, any> = { phone }

      // null removes the override
      body.tabPermissions         = hasTabOverride  ? [...tabAccess]  : null
      body.contentHubPermissions  = hasChOverride   ? [...chAccess]   : null

      const res = await apiFetch('/api/org/user-access', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to save')
      }
      await loadOrg(firebaseToken ?? '').catch(() => {})
      setSuccess(true)
      setTimeout(onClose, 1200)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const initials = (user.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  const ROLE_COLOR: Record<string, string> = {
    admin: '#341272', manager: '#1D4ED8', employee: '#15803D',
  }
  const roleColor = ROLE_COLOR[role] ?? '#5C7378'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl flex flex-col w-full sm:max-w-lg overflow-hidden"
        style={{ maxHeight: '92vh' }}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-black text-sm shrink-0"
            style={{ background: C.sidebar }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-gray-900 text-sm truncate">{user.name}</h2>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full capitalize"
              style={{ background: roleColor + '18', color: roleColor }}>
              {role}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {success && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-green-600" />
            </div>
            <p className="font-bold text-gray-900">Access saved!</p>
            <p className="text-xs text-gray-400">Permissions updated for {user.name}</p>
          </div>
        )}

        {!success && <>

        <div className="flex gap-0 shrink-0 border-b border-gray-100">
          {([
            { id: 'tabs'    as Panel, icon: LayoutGrid,  label: 'Tab Access',  hasOverride: hasTabOverride },
            { id: 'content' as Panel, icon: ShieldCheck, label: 'Content Hub', hasOverride: hasChOverride  },
          ]).map(({ id, icon: Icon, label, hasOverride }) => (
            <button
              key={id}
              onClick={() => setPanel(id)}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-bold transition border-b-2"
              style={{
                borderBottomColor: panel === id ? C.sidebar : 'transparent',
                color: panel === id ? C.sidebar : '#86A0A5',
              }}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {hasOverride && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Custom override active" />
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">

          <div className="flex items-center justify-between px-5 pt-3 pb-1">
            {(panel === 'tabs' ? hasTabOverride : hasChOverride) ? (
              <span className="text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                Custom override active
              </span>
            ) : (
              <span className="text-[10px] text-gray-400">Using role defaults</span>
            )}
            <button
              onClick={panel === 'tabs' ? resetTabs : resetCh}
              className="flex items-center gap-1 text-[10px] font-semibold text-gray-400 hover:text-gray-600 transition"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to role defaults
            </button>
          </div>

          {panel === 'tabs' && (
            <div className="px-5 py-2 space-y-0.5">
              {TAB_DEFS.map(({ key, label, description }) => (
                <label
                  key={key}
                  className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded-xl px-2 -mx-2 transition"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-800">{label}</p>
                    <p className="text-[11px] text-gray-400">{description}</p>
                  </div>
                  <div className="relative shrink-0">
                    <input
                      type="checkbox"
                      checked={tabAccess.has(key)}
                      onChange={() => toggleTab(key)}
                      className="sr-only"
                    />
                    <div
                      className="w-10 h-5 rounded-full transition-colors duration-200"
                      style={{ background: tabAccess.has(key) ? C.sidebar : '#D1D5DB' }}
                    >
                      <span
                        className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200"
                        style={{ transform: tabAccess.has(key) ? 'translateX(22px)' : 'translateX(2px)' }}
                      />
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}

          {panel === 'content' && (
            <div className="px-5 py-2">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest pt-3 pb-1">Reports</p>
              {allContentTypes
                .filter(ct => ct.category === 'report')
                .map(ct => (
                  <ContentRow key={ct.id} id={ct.id} label={ct.title} checked={chAccess.has(ct.id)} onToggle={toggleCh} />
                ))
              }
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest pt-4 pb-1">Content & Communications</p>
              {allContentTypes
                .filter(ct => ct.category === 'content')
                .map(ct => (
                  <ContentRow key={ct.id} id={ct.id} label={ct.title} checked={chAccess.has(ct.id)} onToggle={toggleCh} />
                ))
              }
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest pt-4 pb-1">Social Media</p>
              <ContentRow id="_social" label="All Social Platforms" checked={chAccess.has('_social')} onToggle={toggleCh} />
              <div className="h-3" />
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={save}
            disabled={saving}
            className="w-full py-3 rounded-xl text-white text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
            style={{ background: C.sidebar }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save Access Settings'}
          </button>
        </div>

        </>}
      </div>
    </div>
  )
}

function ContentRow({ id, label, checked, onToggle }: {
  id: string; label: string; checked: boolean; onToggle: (id: string) => void
}) {
  return (
    <label className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded-xl px-2 -mx-2 transition">
      <span className="flex-1 text-sm text-gray-700">{label}</span>
      <div className="relative shrink-0">
        <input type="checkbox" checked={checked} onChange={() => onToggle(id)} className="sr-only" />
        <div
          className="w-10 h-5 rounded-full transition-colors duration-200"
          style={{ background: checked ? '#1D4ED8' : '#D1D5DB' }}
        >
          <span
            className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200"
            style={{ transform: checked ? 'translateX(22px)' : 'translateX(2px)' }}
          />
        </div>
      </div>
    </label>
  )
}
