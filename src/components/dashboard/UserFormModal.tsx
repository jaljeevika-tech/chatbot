/** Add or edit a user (POST /api/add-user, PUT /api/update-user); onSuccess lets the parent refresh. */

import { useState, useEffect } from 'react'
import { X, Loader2, ShieldCheck, UserCheck, User, AlertCircle, CheckCircle2, Eye, EyeOff, Tag, Briefcase, FolderOpen } from 'lucide-react'
import type { UserRow } from '../../utils/authSheet'
import type { ProjectDef } from '../../types/org'
import { apiFetch } from '../../utils/apiFetch'

const C = {
  sidebar: '#341272',
  dark:    '#0E3A46',   // FF.tealDark
  surface: '#D9E6E8',   // FF.border
  faint:   '#FBF9F4',   // FF.bgWarm
  muted:   '#86A0A5',   // FF.textFaint
}

interface Props {
  mode: 'add' | 'edit'
  user?: UserRow           // pre-filled when editing
  managers: UserRow[]      // list of admins/managers for the manager dropdown
  projects: ProjectDef[]   // org project list for assignment
  onClose: () => void
  onSuccess: () => void
}

type Role = 'admin' | 'manager' | 'employee'

const ROLE_OPTIONS: { value: Role; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'admin',    label: 'Admin',    color: '#341272', icon: <ShieldCheck className="w-4 h-4" /> },
  { value: 'manager',  label: 'Manager',  color: '#1D4ED8', icon: <UserCheck   className="w-4 h-4" /> },
  { value: 'employee', label: 'Employee', color: '#15803D', icon: <User        className="w-4 h-4" /> },
]

export function UserFormModal({ mode, user, managers, projects, onClose, onSuccess }: Props) {
  const [name,        setName]        = useState(user?.name        ?? '')
  const [phone,       setPhone]       = useState(user?.phone       ?? '')
  const [state,       setState]       = useState(user?.state       ?? '')
  const [role,        setRole]        = useState<Role>((user?.role?.toLowerCase() as Role) ?? 'employee')
  const [manager,     setManager]     = useState(user?.manager     ?? '')
  const [password,    setPassword]    = useState(user?.password    ?? '')
  const [employeeId,  setEmployeeId]  = useState(user?.employee_id ?? '')
  const [designation, setDesignation] = useState(user?.designation ?? '')
  const [projectIds,  setProjectIds]  = useState<string[]>(
    user?.project_ids ? user.project_ids.split(',').map(s => s.trim()).filter(Boolean) : []
  )

  const [active,       setActive]       = useState<boolean>((user?.active?.toUpperCase() ?? 'TRUE') !== 'FALSE')
  const [showPassword, setShowPassword] = useState(false)

  function toggleProject(id: string) {
    setProjectIds(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id])
  }

  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function validate(): string {
    if (!name.trim())  return 'Name is required.'
    if (!phone.trim()) return 'Phone number is required.'
    if (!/^\d{10,13}$/.test(phone.replace(/[\s\-\+]/g, '')))
      return 'Enter a valid phone number (10–13 digits).'
    if (!role)         return 'Role is required.'
    if (mode === 'add' && !password.trim()) return 'Password is required for new users.'
    return ''
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validate()
    if (err) { setError(err); return }

    setSaving(true)
    setError('')

    try {
      const body: Record<string, any> = {
        name:        name.trim(),
        phone:       phone.replace(/[\s\-\+]/g, ''),
        state:       state.trim(),
        role,
        manager:     manager.trim(),
        password:    password.trim(),
        employee_id: employeeId.trim(),
        designation: designation.trim(),
        project_ids: projectIds,
      }
      if (mode === 'edit') {
        body.originalPhone = user!.phone
        body.active = active ? 'TRUE' : 'FALSE'
      }

      const res = await apiFetch(
        mode === 'add' ? '/api/add-user' : '/api/update-user',
        {
          method:  mode === 'add' ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        }
      )
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`)

      setSuccess(true)
      setTimeout(() => { onSuccess(); onClose() }, 1200)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const isEdit = mode === 'edit'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-3xl flex flex-col"
        style={{ maxHeight: '95vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: C.sidebar }}>
              <User className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="font-bold text-gray-900 text-sm">{isEdit ? 'Edit User' : 'Add New User'}</h2>
              <p className="text-[10px]" style={{ color: C.muted }}>
                {isEdit ? `Editing ${user?.name}` : 'Saves directly to Google Sheet'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition">
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {success && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-12">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-green-600" />
            </div>
            <p className="font-bold text-gray-900">{isEdit ? 'User updated!' : 'User added!'}</p>
            <p className="text-xs text-gray-400">Refreshing user list…</p>
          </div>
        )}

        {!success && (
          <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

            {error && (
              <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-xl p-3 text-sm border border-red-100">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <Field label="Full Name" required>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 outline-none focus:border-purple-400 transition"
              />
            </Field>

            <Field label="Phone Number" required hint="10-digit mobile number (without +91)">
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value.replace(/[^\d\+\-\s]/g, ''))}
                placeholder="e.g. 9876543210"
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 outline-none focus:border-purple-400 transition font-mono"
              />
            </Field>

            <Field label="Role" required>
              <div className="grid grid-cols-3 gap-2">
                {ROLE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setRole(opt.value)}
                    className="flex flex-col items-center gap-1.5 py-2.5 rounded-xl border text-xs font-bold transition"
                    style={{
                      background:  role === opt.value ? opt.color : '#F9FAFB',
                      color:       role === opt.value ? '#ffffff' : '#374151',
                      borderColor: role === opt.value ? opt.color : '#D9E6E8',
                    }}
                  >
                    {opt.icon}
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="State / Region">
              <input
                type="text"
                value={state}
                onChange={e => setState(e.target.value)}
                placeholder="e.g. Bihar"
                className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 outline-none focus:border-purple-400 transition"
              />
            </Field>

            <Field label="Employee ID" hint="Unique staff identifier (e.g. TATWA-001)">
              <div className="relative">
                <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
                <input
                  type="text"
                  value={employeeId}
                  onChange={e => setEmployeeId(e.target.value)}
                  placeholder="e.g. JJK-042"
                  className="w-full text-sm border border-gray-200 rounded-xl pl-8 pr-3 py-2.5 outline-none focus:border-purple-400 transition font-mono"
                />
              </div>
            </Field>

            <Field label="Designation / Job Title">
              <div className="relative">
                <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-300 pointer-events-none" />
                <input
                  type="text"
                  value={designation}
                  onChange={e => setDesignation(e.target.value)}
                  placeholder="e.g. Field Coordinator"
                  className="w-full text-sm border border-gray-200 rounded-xl pl-8 pr-3 py-2.5 outline-none focus:border-purple-400 transition"
                />
              </div>
            </Field>

            {projects.length > 0 && (
              <Field label="Assigned Projects" hint="Select all projects this person works on">
                <div className="flex flex-wrap gap-2 mt-1">
                  {projects.map(p => {
                    const selected = projectIds.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => toggleProject(p.id)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition"
                        style={{
                          background:  selected ? p.color : '#F9FAFB',
                          color:       selected ? '#fff'   : '#374151',
                          borderColor: selected ? p.color  : '#D9E6E8',
                        }}
                      >
                        <FolderOpen className="w-3 h-3" />
                        {p.label}
                      </button>
                    )
                  })}
                </div>
              </Field>
            )}

            {/* Manager: employees and managers only */}
            {(role === 'employee' || role === 'manager') && (
              <Field label="Reports To (Manager)" hint="Select a manager or type a name">
                <select
                  value={manager}
                  onChange={e => setManager(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 outline-none focus:border-purple-400 transition bg-white"
                >
                  <option value="">— None / Not assigned —</option>
                  {managers.map(m => (
                    <option key={m.phone} value={m.name}>{m.name} ({m.role})</option>
                  ))}
                </select>
              </Field>
            )}

            <Field
              label="Password"
              required={!isEdit}
              hint={isEdit ? 'Leave blank to keep current password' : 'Plain-text login password'}
            >
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={isEdit ? '(unchanged)' : 'Enter password'}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 pr-10 outline-none focus:border-purple-400 transition font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>

            {/* Account status: edit mode only */}
            {isEdit && (
              <Field label="Account Status">
                <div
                  className="flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition"
                  style={{ borderColor: active ? '#bbf7d0' : '#fca5a5', background: active ? '#f0fdf4' : '#fef2f2' }}
                  onClick={() => setActive(v => !v)}
                >
                  <button
                    type="button"
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${active ? 'bg-green-500' : 'bg-red-400'}`}
                  >
                    <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${active ? 'translate-x-[22px]' : 'translate-x-1'}`} />
                  </button>
                  <div>
                    <p className={`text-sm font-bold ${active ? 'text-green-700' : 'text-red-600'}`}>
                      {active ? '✅ Active' : '🚫 Inactive'}
                    </p>
                    <p className="text-[10px] text-gray-500">
                      {active ? 'User can log in normally' : 'Login blocked — user cannot access the app'}
                    </p>
                  </div>
                </div>
              </Field>
            )}

            <div className="pt-2 pb-4">
              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 rounded-xl text-sm font-bold text-white transition disabled:opacity-60 flex items-center justify-center gap-2"
                style={{ background: C.sidebar }}
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add User'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function Field({ label, required, hint, children }: {
  label: string; required?: boolean; hint?: string; children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-bold text-gray-700 flex items-center gap-1">
        {label}
        {required && <span className="text-red-400">*</span>}
      </label>
      {children}
      {hint && <p className="text-[10px]" style={{ color: '#86A0A5' }}>{hint}</p>}
    </div>
  )
}
