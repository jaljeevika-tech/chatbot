import { useState } from 'react'
import { Save, Lock } from 'lucide-react'
import { useOrg } from '../../context/OrgContext'
import { apiFetch } from '../../utils/apiFetch'

export type TabKey = 'overview' | 'reports' | 'media' | 'impact' | 'analytics' | 'notebook' | 'whatsapp' | 'toc'
  | 'portfolio' | 'orgdash' | 'vault' | 'beneficiaries' | 'financial' | 'compliance' | 'projectmedia' | 'annualprogress'
  | 'mis' | 'beneficiaryprofile' | 'hr' | 'financemgmt' | 'forms'
export type TabPermMap = Record<TabKey, ('admin' | 'manager' | 'employee')[]>

export const TAB_DEFS: { key: TabKey; label: string; description: string }[] = [
  { key: 'overview',  label: 'Overview',           description: 'Dashboard home with stats & activity'                  },
  { key: 'reports',   label: 'Reports',             description: 'View & filter field reports'                           },
  { key: 'media',     label: 'Media Library',       description: 'Photos & attachments from the field'                  },
  { key: 'impact',    label: 'Impact Dashboard',    description: 'Outcome indicators & Theory of Change'                },
  { key: 'toc',       label: 'ToC Analysis',        description: 'AI aggregate Theory of Change & metaphor analysis'    },
  { key: 'analytics', label: 'Team Analytics',      description: 'Performance review by team member'                   },
  { key: 'notebook',  label: 'Notebook',            description: 'AI-powered data analysis notebook'                    },
  { key: 'whatsapp',  label: 'WhatsApp',            description: 'WhatsApp broadcast & messaging'                       },
  { key: 'portfolio',     label: 'Portfolio Overview',    description: 'Project cards — health, budget, target, compliance' },
  { key: 'orgdash',       label: 'Org Dashboard',         description: 'Combined KPIs & growth chart across all projects'    },
  { key: 'vault',         label: 'Document Vault',        description: 'Per-project legal/financial/progress/knowledge docs' },
  { key: 'beneficiaries', label: 'Beneficiary and Resource Registration', description: 'Individual/Entrepreneur/Collective/Resources rosters (org-wide) plus a coverage & headcount dashboard' },
  { key: 'financial',     label: 'Financial Tracker',     description: 'Budget utilisation and burn rate'                   },
  { key: 'compliance',    label: 'Compliance Calendar',   description: 'Due dates, renewals and certificate expiry'         },
  { key: 'projectmedia',  label: 'Project Media',         description: 'Per-project photos & attachments from the field'   },
  { key: 'annualprogress',label: 'Annual Progress Report',description: 'Cumulative achievement by activity & location, uploaded monthly' },
  { key: 'mis',           label: 'MIS',                    description: 'Training, Income, Input Distribution, Scheme Access, Credit/Grant Access, Business Development Support, Compliance Support, Campaign, Exposure Visit & Community Meeting — one section with its own sub-tabs' },
  { key: 'beneficiaryprofile', label: 'Beneficiary Profile', description: 'Individual / Micro-Entrepreneur / Collective rosters — complete registered detail plus all MIS data recorded against each beneficiary' },
  { key: 'hr',            label: 'HR Management',          description: 'Attendance check-in/out with GPS, team register, leave requests & approvals — works offline' },
  { key: 'financemgmt',   label: 'Finance Management',     description: 'Advance requests & settlements (manager → Finance), ledger statement requests, compliance calendar' },
  { key: 'forms',         label: 'Forms',                  description: 'Fill the organisation’s published survey forms (works offline) and view submissions' },
]

export const DEFAULT_TAB_PERMISSIONS: TabPermMap = {
  overview:  ['admin', 'manager', 'employee'],
  reports:   ['admin', 'manager', 'employee'],
  media:     ['admin', 'manager', 'employee'],
  impact:    ['admin', 'manager'],
  toc:       ['admin', 'manager'],
  analytics: ['admin', 'manager', 'employee'],
  notebook:  ['admin', 'manager', 'employee'],
  whatsapp:  ['admin'],
  portfolio:     ['admin', 'manager', 'employee'],
  orgdash:       ['admin', 'manager'],
  vault:         ['admin', 'manager'],
  beneficiaries: ['admin', 'manager'],
  financial:     ['admin', 'manager'],
  compliance:    ['admin', 'manager'],
  projectmedia:  ['admin', 'manager'],
  annualprogress: ['admin', 'manager'],
  // Every MIS sub-tab reads/writes behind requireEditor, so there's no employee-level slice.
  mis: ['admin', 'manager'],
  // Org-wide roster + MIS detail; no employee-level slice.
  beneficiaryprofile: ['admin', 'manager'],
  // Everyone checks in and applies for leave; what each person sees inside
  // the tab (team, approvals, settings) is decided by services/hr.
  hr: ['admin', 'manager', 'employee'],
  // Anyone can raise an advance / ask for a ledger statement; approvals and
  // Finance actions inside the tab are gated by services/finance.
  financemgmt: ['admin', 'manager', 'employee'],
  // Field staff fill forms; the server limits staff to their own submissions.
  forms: ['admin', 'manager', 'employee'],
}

interface Props {
  initialPermissions: TabPermMap
  token: string
}

export function TabAccessSettings({ initialPermissions, token }: Props) {
  const { loadOrg } = useOrg()

  const [perms, setPerms] = useState<TabPermMap>(() => {
    const merged = {} as TabPermMap
    for (const { key } of TAB_DEFS) {
      merged[key] = (initialPermissions[key] as any) ?? DEFAULT_TAB_PERMISSIONS[key]
    }
    return merged
  })

  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [saved,  setSaved]  = useState(false)

  function toggle(tab: TabKey, role: 'manager' | 'employee') {
    setPerms(prev => {
      const current = prev[tab] ?? ['admin']
      const has = current.includes(role)
      return {
        ...prev,
        [tab]: has ? current.filter(r => r !== role) : [...current, role],
      }
    })
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch('/api/org/tab-permissions', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ permissions: perms }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }
      await loadOrg(token).catch(() => {})
      setSaved(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="hidden md:flex items-center gap-3 px-5 py-2 bg-gray-50 border-b border-gray-100 shrink-0">
        <span className="flex-1 text-[10px] font-bold text-gray-400 uppercase tracking-widest">Tab / Feature</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className="w-[72px] text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">Admin</span>
          <span className="w-[72px] text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">Manager</span>
          <span className="w-[72px] text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">Employee</span>
        </div>
      </div>

      <div className="hidden md:block px-5">
        {TAB_DEFS.map(({ key, label, description }) => {
          const p = perms[key]
          return (
            <div key={key} className="flex items-center py-3 border-b border-gray-50 last:border-0 gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800">{label}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">{description}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/* Admin: always on */}
                <div className="w-[72px] flex justify-center">
                  <Lock className="w-3.5 h-3.5 text-gray-300" />
                </div>
                <div className="w-[72px] flex justify-center">
                  <input
                    type="checkbox"
                    checked={p.includes('manager')}
                    onChange={() => toggle(key, 'manager')}
                    className="w-4 h-4 accent-purple-600 cursor-pointer"
                  />
                </div>
                <div className="w-[72px] flex justify-center">
                  <input
                    type="checkbox"
                    checked={p.includes('employee')}
                    onChange={() => toggle(key, 'employee')}
                    className="w-4 h-4 accent-purple-600 cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="md:hidden px-4">
        {TAB_DEFS.map(({ key, label, description }) => {
          const p = perms[key]
          return (
            <div key={key} className="py-3 border-b border-gray-50 last:border-0">
              <p className="text-sm font-semibold text-gray-800">{label}</p>
              <p className="text-[11px] text-gray-400 mt-0.5 mb-2">{description}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <div className="flex items-center gap-1.5 py-2 text-xs font-medium text-gray-400">
                  <Lock className="w-3.5 h-3.5 text-gray-300" /> Admin
                </div>
                <label className="flex items-center gap-1.5 py-2 text-xs font-medium text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={p.includes('manager')}
                    onChange={() => toggle(key, 'manager')}
                    className="w-5 h-5 accent-purple-600 cursor-pointer"
                  />
                  Manager
                </label>
                <label className="flex items-center gap-1.5 py-2 text-xs font-medium text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={p.includes('employee')}
                    onChange={() => toggle(key, 'employee')}
                    className="w-5 h-5 accent-purple-600 cursor-pointer"
                  />
                  Employee
                </label>
              </div>
            </div>
          )
        })}
      </div>

      <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
        <p className="text-[11px] text-gray-400">
          Changes take effect immediately — managers and employees will see updated tabs on next page load.
          Admin always has full access.
        </p>
        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}
        {saved && !saving && (
          <p className="text-xs text-green-600 font-semibold">✓ Tab permissions saved</p>
        )}
        <button
          onClick={save}
          disabled={saving}
          className="w-full py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90 transition disabled:opacity-60 flex items-center justify-center gap-2"
          style={{ background: '#341272' }}
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
