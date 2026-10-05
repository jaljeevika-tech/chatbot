import { useState } from 'react'
import { ArrowLeft, Save, Lock } from 'lucide-react'
import { useLanguage } from '../../context/LanguageContext'
import { useOrg } from '../../context/OrgContext'
import { DEFAULT_PERMISSIONS, getContentTypes, type PermissionsMap } from './contentHubTypes'
import { apiFetch } from '../../utils/apiFetch'

export type { Role, PermissionsMap } from './contentHubTypes'

export interface ContentTypeInfo {
  id:       string
  title:    string
  category: 'report' | 'content'
}

interface Props {
  contentTypes?:       ContentTypeInfo[]   // optional — built internally if omitted
  initialPermissions:  PermissionsMap
  token:               string
  showBackButton?:     boolean             // default true (modal usage)
  onBack:              () => void
  onSaved:             (permissions: PermissionsMap) => void
}

export function ContentHubSettings({
  contentTypes: contentTypesProp,
  initialPermissions,
  token,
  showBackButton = true,
  onBack,
  onSaved,
}: Props) {
  const { t } = useLanguage()
  const { loadOrg } = useOrg()

  const contentTypes: ContentTypeInfo[] = contentTypesProp && contentTypesProp.length > 0
    ? contentTypesProp
    : getContentTypes(t)
        .filter(ct => ct.category !== 'social')
        .map(ct => ({ id: ct.id, title: ct.title, category: ct.category as 'report' | 'content' }))

  // Merge with defaults so every key is present
  const [perms, setPerms] = useState<PermissionsMap>(() => {
    const merged: PermissionsMap = {}
    const allKeys = [...contentTypes.map(c => c.id), '_social']
    for (const key of allKeys) {
      merged[key] = initialPermissions[key] ?? DEFAULT_PERMISSIONS[key] ?? ['admin']
    }
    return merged
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [saved,  setSaved]  = useState(false)

  function toggle(id: string, role: 'manager' | 'employee') {
    setPerms(prev => {
      const current = prev[id] ?? ['admin']
      const has = current.includes(role)
      return {
        ...prev,
        [id]: has ? current.filter(r => r !== role) : [...current, role],
      }
    })
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch('/api/org/content-hub-permissions', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ permissions: perms }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }
      // Refresh OrgContext so the new permissions apply everywhere immediately
      await loadOrg(token).catch(() => {})
      setSaved(true)
      onSaved(perms)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const reportTypes  = contentTypes.filter(c => c.category === 'report')
  const contentList  = contentTypes.filter(c => c.category === 'content')

  function Row({ id, label }: { id: string; label: string }) {
    const p = perms[id] ?? ['admin']
    return (
      <>
        <div className="hidden md:flex items-center py-2.5 border-b border-gray-50 last:border-0 gap-3">
          <span className="flex-1 text-sm text-gray-700 min-w-0 truncate">{label}</span>
          <div className="flex items-center gap-1 shrink-0">
            {/* Admin: always on, locked */}
            <div className="w-[72px] flex justify-center">
              <Lock className="w-3.5 h-3.5 text-gray-300" />
            </div>
            <div className="w-[72px] flex justify-center">
              <input
                type="checkbox"
                checked={p.includes('manager')}
                onChange={() => toggle(id, 'manager')}
                className="w-4 h-4 accent-green-600 cursor-pointer"
              />
            </div>
            <div className="w-[72px] flex justify-center">
              <input
                type="checkbox"
                checked={p.includes('employee')}
                onChange={() => toggle(id, 'employee')}
                className="w-4 h-4 accent-green-600 cursor-pointer"
              />
            </div>
          </div>
        </div>

        <div className="md:hidden py-2.5 border-b border-gray-50 last:border-0">
          <p className="text-sm text-gray-700 mb-1.5">{label}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex items-center gap-1.5 py-1.5 text-xs font-medium text-gray-400">
              <Lock className="w-3.5 h-3.5 text-gray-300" /> Admin
            </div>
            <label className="flex items-center gap-1.5 py-1.5 text-xs font-medium text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={p.includes('manager')}
                onChange={() => toggle(id, 'manager')}
                className="w-5 h-5 accent-green-600 cursor-pointer"
              />
              Manager
            </label>
            <label className="flex items-center gap-1.5 py-1.5 text-xs font-medium text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={p.includes('employee')}
                onChange={() => toggle(id, 'employee')}
                className="w-5 h-5 accent-green-600 cursor-pointer"
              />
              Employee
            </label>
          </div>
        </div>
      </>
    )
  }

  function SectionHeader({ label }: { label: string }) {
    return (
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest pt-4 pb-1">
        {label}
      </p>
    )
  }

  return (
    <div className="flex flex-col" style={{ maxHeight: '90vh' }}>
      <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
        {showBackButton && (
          <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-gray-100 transition">
            <ArrowLeft className="w-4 h-4 text-gray-600" />
          </button>
        )}
        <div>
          <h2 className="font-bold text-gray-900 text-sm">Content Hub Permissions</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">Control role access to each feature</p>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-3 px-5 py-2 bg-gray-50 border-b border-gray-100 shrink-0">
        <span className="flex-1 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Feature</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className="w-[72px] text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">Admin</span>
          <span className="w-[72px] text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">Manager</span>
          <span className="w-[72px] text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">Employee</span>
        </div>
      </div>

      <div className="overflow-y-auto flex-1 px-5">
        {reportTypes.length > 0 && (
          <>
            <SectionHeader label="Reports" />
            {reportTypes.map(ct => <Row key={ct.id} id={ct.id} label={ct.title} />)}
          </>
        )}
        {contentList.length > 0 && (
          <>
            <SectionHeader label="Content & Communications" />
            {contentList.map(ct => <Row key={ct.id} id={ct.id} label={ct.title} />)}
          </>
        )}
        <SectionHeader label="Social Media Posts" />
        <Row id="_social" label="All Social Platforms" />
        <div className="h-3" />
      </div>

      <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
        {error && (
          <p className="text-xs text-red-500 text-center">{error}</p>
        )}
        {saved && !saving && (
          <p className="text-xs text-green-600 text-center font-semibold">✓ Permissions saved</p>
        )}
        <button
          onClick={save}
          disabled={saving}
          className="w-full py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold hover:bg-green-700 transition disabled:opacity-60 flex items-center justify-center gap-2"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
