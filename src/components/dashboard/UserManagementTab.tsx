import { apiFetch } from '../../utils/apiFetch'
/** Admin-only user directory with per-user activity stats; add, edit, merge and delete users. */

import { useState, useMemo } from 'react'
import {
  Search, ExternalLink, Users, ShieldCheck, UserCheck, User,
  Phone, MapPin, Briefcase, Plus, Pencil, Trash2, Loader2, AlertCircle,
  Eye, EyeOff, KeyRound, ToggleLeft, SlidersHorizontal, Tag, FolderOpen, GitMerge,
} from 'lucide-react'
import { useReportContext } from '../../context/ReportContext'
import { useLanguage } from '../../context/LanguageContext'
import { useOrg } from '../../context/OrgContext'
import { UserFormModal } from './UserFormModal'
import { UserAccessModal } from './UserAccessModal'
import { DEFAULT_TAB_PERMISSIONS } from './TabAccessSettings'
import type { TabPermMap } from './TabAccessSettings'
import type { PermissionsMap } from './ContentHubSettings'
import type { DailyReport } from '../../types/report'
import type { UserRow } from '../../utils/authSheet'

const C = {
  dark:    '#0E3A46',   // FF.tealDark
  sidebar: '#341272',
  lime:    '#16a34a',   // green — beneficiary/impact accent (kept distinct from FF.green)
  surface: '#D9E6E8',   // FF.border
  faint:   '#FBF9F4',   // FF.bgWarm
  muted:   '#86A0A5',   // FF.textFaint
}

const ROLE_CONFIG: Record<string, { label: string; bg: string; color: string; icon: React.ReactNode }> = {
  admin:    { label: 'Admin',    bg: '#FBF9F4', color: '#341272', icon: <ShieldCheck className="w-3 h-3" /> },
  manager:  { label: 'Manager',  bg: '#EFF6FF', color: '#1D4ED8', icon: <UserCheck  className="w-3 h-3" /> },
  employee: { label: 'Employee', bg: '#F0FDF4', color: '#15803D', icon: <User       className="w-3 h-3" /> },
}

function roleCfg(role: string) {
  return ROLE_CONFIG[role?.toLowerCase()] ?? { label: role || 'Unknown', bg: '#F9FAFB', color: '#5C7378', icon: <User className="w-3 h-3" /> }
}

function maskPhone(phone: string) {
  if (!phone || phone.length < 4) return phone
  return '••••••' + phone.slice(-4)
}

interface UserStats {
  reportCount: number
  totalBenef: number
  lastDate: string
  stateCount: number
}

interface Props {
  reports: DailyReport[]
}

type ModalState =
  | { open: false }
  | { open: true; mode: 'add' }
  | { open: true; mode: 'edit'; user: UserRow }

export function UserManagementTab({ reports }: Props) {
  const { users, refreshReports } = useReportContext()
  const { t } = useLanguage()
  const { org } = useOrg()
  const [search,     setSearch]     = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [sortBy,     setSortBy]     = useState<'name' | 'reports' | 'role'>('reports')
  const [modal,      setModal]      = useState<ModalState>({ open: false })
  const [deleting,   setDeleting]   = useState<string | null>(null)
  const [deleteErr,  setDeleteErr]  = useState<string>('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [accessUser, setAccessUser] = useState<UserRow | null>(null)
  const [mergeSource, setMergeSource] = useState<UserRow | null>(null)   // user to merge FROM
  const [mergingInto, setMergingInto] = useState<string>('')             // primary phone
  const [merging,     setMerging]     = useState(false)
  const [mergeErr,    setMergeErr]    = useState('')

  const [showPwdMap,   setShowPwdMap]   = useState<Record<string, boolean>>({})
  const [showPhoneMap, setShowPhoneMap] = useState<Record<string, boolean>>({})
  const [togglingMap,  setTogglingMap]  = useState<Record<string, boolean>>({})

  const orgTabPerms: TabPermMap  = (org?.tabPermissions as TabPermMap)  ?? DEFAULT_TAB_PERMISSIONS
  const orgChPerms:  PermissionsMap = (org?.contentHubPermissions as PermissionsMap) ?? {}

  const normPhone = (p: string) => {
    const c = String(p || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
    return c.length === 10 ? '91' + c : c
  }
  const userHasOverride = (phone: string) => {
    const p = normPhone(phone)
    return !!(org?.userTabPermissions?.[p] || org?.userContentHubPermissions?.[p])
  }

  const normalise = (p: string) => {
    const c = String(p || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
    return c.length === 10 ? '91' + c : c
  }

  const statsMap = useMemo(() => {
    const m = new Map<string, UserStats>()
    const statesMap = new Map<string, Set<string>>()
    reports.forEach(r => {
      const key = normalise(r.phone)
      const cur = m.get(key) ?? { reportCount: 0, totalBenef: 0, lastDate: '', stateCount: 0 }
      const ds  = String(r.timestamp).slice(0, 10)
      m.set(key, {
        reportCount: cur.reportCount + 1,
        totalBenef:  cur.totalBenef + (parseInt(String(r.beneficiaries ?? 0)) || 0),
        lastDate:    ds > cur.lastDate ? ds : cur.lastDate,
        stateCount:  cur.stateCount,
      })
      if (!statesMap.has(key)) statesMap.set(key, new Set())
      if (r.state) statesMap.get(key)!.add(r.state)
    })
    statesMap.forEach((states, key) => {
      const cur = m.get(key)
      if (cur) m.set(key, { ...cur, stateCount: states.size })
    })
    return m
  }, [reports])

  const roleCounts = useMemo(() => {
    const c = { admin: 0, manager: 0, employee: 0 }
    users.forEach(u => {
      const r = u.role?.toLowerCase()
      if (r === 'admin' || r === 'manager' || r === 'employee') c[r]++
    })
    return c
  }, [users])

  const managerOptions = useMemo(() =>
    users.filter(u => u.role?.toLowerCase() === 'admin' || u.role?.toLowerCase() === 'manager'),
    [users]
  )

  const projects = org?.projects ?? []

  const projectLabel = (id: string) => projects.find((p: any) => p.id === id)?.label ?? id
  const projectColor = (id: string) => projects.find((p: any) => p.id === id)?.color ?? '#9CA3AF'

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return users
      .filter(u => {
        if (roleFilter !== 'all' && u.role?.toLowerCase() !== roleFilter) return false
        if (!q) return true
        return (
          u.name?.toLowerCase().includes(q) ||
          u.phone?.includes(q) ||
          u.state?.toLowerCase().includes(q) ||
          u.manager?.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '')
        if (sortBy === 'role') return (a.role || '').localeCompare(b.role || '')
        const ra = statsMap.get(normalise(a.phone))?.reportCount ?? 0
        const rb = statsMap.get(normalise(b.phone))?.reportCount ?? 0
        return rb - ra
      })
  }, [users, search, roleFilter, sortBy, statsMap])

  async function handleToggleActive(phone: string, active: boolean) {
    setTogglingMap(m => ({ ...m, [phone]: true }))
    try {
      const res  = await apiFetch('/api/set-user-active', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, active }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Error ${res.status}`)
      await refreshReports()
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Failed to update status')
    } finally {
      setTogglingMap(m => ({ ...m, [phone]: false }))
    }
  }

  async function handleDelete(phone: string) {
    setDeleting(phone)
    setDeleteErr('')
    try {
      const res  = await apiFetch('/api/delete-user', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Error ${res.status}`)
      setConfirmDel(null)
      await refreshReports()
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  async function handleMerge() {
    if (!mergeSource || !mergingInto.trim()) return
    if (!confirm(`Remove "${mergeSource.name}" and merge into the selected primary user? This cannot be undone.`)) return
    setMerging(true); setMergeErr('')
    try {
      const res  = await apiFetch('/api/merge-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryPhone: mergingInto.trim(), secondaryPhone: mergeSource.phone }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Error ${res.status}`)
      setMergeSource(null); setMergingInto('')
      await refreshReports()
    } catch (e) {
      setMergeErr(e instanceof Error ? e.message : 'Merge failed')
    } finally { setMerging(false) }
  }

  // This org's own users sheet only; no sheet configured means no link.
  const ownSheetId = org?.data_sources?.users_sheet_id?.trim()
  const SHEETS_URL = ownSheetId ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ownSheetId)}/edit` : null

  return (
    <div className="space-y-4 pb-8">

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: t.totalUsers,  value: users.length,        color: C.sidebar,  icon: <Users       className="w-4 h-4" /> },
          { label: t.admins,      value: roleCounts.admin,    color: '#341272',  icon: <ShieldCheck className="w-4 h-4" /> },
          { label: t.managers,    value: roleCounts.manager,  color: '#1D4ED8',  icon: <UserCheck   className="w-4 h-4" /> },
          { label: t.fieldStaff,  value: roleCounts.employee, color: '#15803D',  icon: <User        className="w-4 h-4" /> },
        ].map(s => (
          <div key={s.label} className="rounded-2xl p-3 flex items-center gap-3" style={{ background: C.faint }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: s.color, color: '#fff' }}>
              {s.icon}
            </div>
            <div>
              <div className="text-xl font-serif font-semibold" style={{ color: C.dark }}>{s.value}</div>
              <div className="text-[10px] font-semibold" style={{ color: C.muted }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {deleteErr && (
        <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-xl p-3 text-sm border border-red-100">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{deleteErr}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[180px] bg-white border border-gray-100 rounded-xl px-3 py-2 shadow-sm">
          <Search className="w-4 h-4 shrink-0" style={{ color: C.muted }} />
          <input
            type="text"
            placeholder={t.searchPlaceholder}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="flex-1 text-sm outline-none bg-transparent placeholder-gray-300"
          />
        </div>

        {(['all', 'admin', 'manager', 'employee'] as const).map(r => (
          <button
            key={r}
            onClick={() => setRoleFilter(r)}
            className="text-xs px-3 py-1.5 rounded-full border font-semibold transition"
            style={{
              background:  roleFilter === r ? C.sidebar : '#ffffff',
              color:       roleFilter === r ? '#ffffff' : C.sidebar,
              borderColor: roleFilter === r ? C.sidebar : C.surface,
            }}
          >
            {r === 'all' ? t.filterAll : roleCfg(r).label}
          </button>
        ))}

        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as typeof sortBy)}
          className="text-xs border border-gray-100 rounded-xl px-2.5 py-1.5 bg-white outline-none font-semibold cursor-pointer"
          style={{ color: C.dark }}
        >
          <option value="reports">{t.sortMostActive}</option>
          <option value="name">{t.sortNameAZ}</option>
          <option value="role">{t.sortRole}</option>
        </select>

        {SHEETS_URL && (
          <a
            href={SHEETS_URL} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl border transition hover:opacity-80"
            style={{ background: C.faint, color: C.sidebar, borderColor: C.surface }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {t.sheets}
          </a>
        )}

        <button
          onClick={() => setModal({ open: true, mode: 'add' })}
          className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl transition text-white"
          style={{ background: C.sidebar }}
        >
          <Plus className="w-3.5 h-3.5" />
          {t.addUser}
        </button>
      </div>

      <p className="text-xs font-semibold" style={{ color: C.muted }}>
        {filtered.length} user{filtered.length !== 1 ? 's' : ''}{(search || roleFilter !== 'all') ? ' matching' : ' total'}
      </p>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">{t.noUsersFound}</p>
          <button
            onClick={() => setModal({ open: true, mode: 'add' })}
            className="mt-4 text-xs font-bold px-4 py-2 rounded-xl text-white transition"
            style={{ background: C.sidebar }}
          >
            {t.addFirstUser}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(user => {
            const key      = normalise(user.phone)
            const stats    = statsMap.get(key)
            const cfg      = roleCfg(user.role)
            const initials = (user.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
            const isConfirmingDelete = confirmDel === user.phone
            const isDeletingThis    = deleting    === user.phone
            const isActive   = (user.active?.toUpperCase() ?? 'TRUE') !== 'FALSE'
            const toggling   = togglingMap[user.phone]  ?? false
            const showPwd    = showPwdMap[user.phone]   ?? false
            const showPhone  = showPhoneMap[user.phone] ?? false

            return (
              <div
                key={user.phone || user.name}
                className="bg-white rounded-2xl border flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
                style={{ borderColor: isConfirmingDelete ? '#FCA5A5' : !isActive ? '#FDE68A' : C.surface }}
              >
                {isConfirmingDelete && (
                  <div className="bg-red-50 px-4 pt-4 pb-3 flex flex-col gap-2">
                    <p className="text-sm font-bold text-red-700">{t.deleteUserTitle.replace('{name}', user.name)}</p>
                    <p className="text-xs text-red-500">{t.deleteWarning}</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDelete(user.phone)}
                        disabled={isDeletingThis}
                        className="flex-1 py-1.5 rounded-lg text-xs font-bold text-white bg-red-600 hover:bg-red-700 transition flex items-center justify-center gap-1 disabled:opacity-60"
                      >
                        {isDeletingThis ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        {isDeletingThis ? t.deleting : t.yesDelete}
                      </button>
                      <button
                        onClick={() => { setConfirmDel(null); setDeleteErr('') }}
                        className="flex-1 py-1.5 rounded-lg text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 transition"
                      >
                        {t.cancel}
                      </button>
                    </div>
                  </div>
                )}

                <div className="p-4 flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-white font-black text-sm shadow-sm"
                      style={{ background: C.sidebar }}
                    >
                      {initials}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-gray-900 text-sm truncate">{user.name || '—'}</p>
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full mt-0.5"
                        style={{ background: cfg.bg, color: cfg.color }}
                      >
                        {cfg.icon}
                        {cfg.label}
                      </span>
                    </div>

                    {!isConfirmingDelete && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => handleToggleActive(user.phone, !isActive)}
                          disabled={toggling}
                          title={isActive ? 'Active — click to deactivate' : 'Inactive — click to activate'}
                          className={`relative inline-flex h-5 w-9 rounded-full transition-colors duration-200 shrink-0 ${
                            toggling ? 'opacity-40 cursor-wait' : 'cursor-pointer'
                          } ${isActive ? 'bg-green-500' : 'bg-gray-300'}`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                            isActive ? 'translate-x-[18px]' : 'translate-x-0.5'
                          }`} />
                        </button>
                        <button
                          onClick={() => setAccessUser(user)}
                          title="Customize access"
                          className="relative p-1.5 rounded-lg hover:bg-indigo-50 transition"
                          style={{ color: '#6366F1' }}
                        >
                          <SlidersHorizontal className="w-3.5 h-3.5" />
                          {userHasOverride(user.phone) && (
                            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                          )}
                        </button>
                        <button
                          onClick={() => setModal({ open: true, mode: 'edit', user })}
                          title="Edit user"
                          className="p-1.5 rounded-lg hover:bg-purple-50 transition"
                          style={{ color: C.sidebar }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => { setConfirmDel(user.phone); setDeleteErr('') }}
                          title="Delete user"
                          className="p-1.5 rounded-lg hover:bg-red-50 transition text-red-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {!isActive && (
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                      <ToggleLeft className="w-3.5 h-3.5 shrink-0" />
                      Account Inactive — login blocked
                    </div>
                  )}

                  <div className="space-y-1.5">
                    {(user.employee_id || user.designation) && (
                      <div className="flex items-center gap-2 flex-wrap">
                        {user.employee_id && (
                          <span className="flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-600">
                            <Tag className="w-2.5 h-2.5" />{user.employee_id}
                          </span>
                        )}
                        {user.designation && (
                          <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                            <Briefcase className="w-2.5 h-2.5" />{user.designation}
                          </span>
                        )}
                      </div>
                    )}
                    {user.phone && (
                      <div className="flex items-center gap-2 text-xs" style={{ color: C.muted }}>
                        <Phone className="w-3.5 h-3.5 shrink-0" />
                        <span className="font-mono flex-1">{showPhone ? user.phone : maskPhone(user.phone)}</span>
                        <button
                          onClick={() => setShowPhoneMap(m => ({ ...m, [user.phone]: !showPhone }))}
                          className="hover:text-gray-600 transition"
                          title={showPhone ? 'Hide number' : 'Reveal number'}
                        >
                          {showPhone ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                      </div>
                    )}
                    {user.state && (
                      <div className="flex items-center gap-2 text-xs" style={{ color: C.muted }}>
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span>{user.state}</span>
                      </div>
                    )}
                    {user.manager && (
                      <div className="flex items-center gap-2 text-xs" style={{ color: C.muted }}>
                        <Briefcase className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{t.reportsTo.replace('{manager}', user.manager)}</span>
                      </div>
                    )}
                    {user.project_ids && user.project_ids.trim() && (
                      <div className="flex flex-wrap gap-1">
                        {user.project_ids.split(',').map(s => s.trim()).filter(Boolean).map(pid => (
                          <span key={pid}
                            className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white"
                            style={{ background: projectColor(pid) }}>
                            <FolderOpen className="w-2.5 h-2.5" />{projectLabel(pid)}
                          </span>
                        ))}
                      </div>
                    )}
                    {user.password && (
                      <div className="flex items-center gap-2 text-xs" style={{ color: C.muted }}>
                        <KeyRound className="w-3.5 h-3.5 shrink-0" />
                        <span className="font-mono flex-1 tracking-widest">{showPwd ? user.password : '••••••••'}</span>
                        <button
                          onClick={() => setShowPwdMap(m => ({ ...m, [user.phone]: !showPwd }))}
                          className="hover:text-gray-600 transition"
                          title={showPwd ? 'Hide password' : 'Reveal password'}
                        >
                          {showPwd ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => { setMergeSource(user); setMergingInto(''); setMergeErr('') }}
                      className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-purple-600 transition mt-0.5"
                      title="Merge this duplicate into another user"
                    >
                      <GitMerge className="w-3 h-3" /> Mark as duplicate
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-1 pt-2 border-t" style={{ borderColor: C.surface }}>
                    <div className="text-center">
                      <div className="text-sm font-black" style={{ color: C.dark }}>{stats?.reportCount ?? 0}</div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.reports}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-black" style={{ color: C.lime }}>
                        {stats?.totalBenef
                          ? stats.totalBenef > 999
                            ? `${(stats.totalBenef / 1000).toFixed(1)}k`
                            : stats.totalBenef.toLocaleString('en-IN')
                          : '—'}
                      </div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.reached}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-black" style={{ color: C.dark }}>{stats?.stateCount ?? '—'}</div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: C.muted }}>{t.statsStates}</div>
                    </div>
                  </div>

                  {stats?.lastDate
                    ? <p className="text-[9px] font-semibold" style={{ color: C.muted }}>{t.lastActive.replace('{date}', stats.lastDate)}</p>
                    : <p className="text-[9px] font-semibold text-orange-400">{t.noReportsSubmitted}</p>
                  }
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal.open && (
        <UserFormModal
          mode={modal.mode}
          user={modal.mode === 'edit' ? modal.user : undefined}
          managers={managerOptions}
          projects={projects}
          onClose={() => setModal({ open: false })}
          onSuccess={async () => { await refreshReports() }}
        />
      )}

      {mergeSource && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setMergeSource(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-purple-100 flex items-center justify-center">
                <GitMerge className="w-4 h-4 text-purple-600" />
              </div>
              <div>
                <p className="font-bold text-gray-900 text-sm">Merge Duplicate</p>
                <p className="text-[10px] text-gray-400">"{mergeSource.name}" will be removed from the sheet</p>
              </div>
            </div>
            {mergeErr && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{mergeErr}</p>}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-700">Merge INTO (primary user)</label>
              <select
                value={mergingInto}
                onChange={e => setMergingInto(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 outline-none focus:border-purple-400 bg-white"
              >
                <option value="">— Select primary user —</option>
                {users.filter(u => u.phone !== mergeSource.phone).map(u => (
                  <option key={u.phone} value={u.phone}>{u.name} ({u.role})</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400">The primary user keeps their record; the duplicate row is deleted. Reports are not automatically reassigned.</p>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={handleMerge} disabled={!mergingInto || merging}
                className="flex-1 py-2 rounded-xl text-xs font-bold text-white transition disabled:opacity-50 flex items-center justify-center gap-1.5"
                style={{ background: '#6D28D9' }}>
                {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />}
                {merging ? 'Merging…' : 'Confirm Merge'}
              </button>
              <button onClick={() => setMergeSource(null)}
                className="flex-1 py-2 rounded-xl text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 transition">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {accessUser && (
        <UserAccessModal
          user={accessUser}
          orgTabPerms={orgTabPerms}
          orgChPerms={orgChPerms}
          onClose={() => setAccessUser(null)}
        />
      )}
    </div>
  )
}
