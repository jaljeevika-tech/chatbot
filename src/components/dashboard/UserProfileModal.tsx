// Opened from the sidebar avatar; holds the explicit, confirmed Sign Out.

import { X, Phone, ShieldCheck, Building2, LogOut } from 'lucide-react'
import { ModalShell } from '../ui/ModalShell'
import { useAuthContext } from '../../context/AuthContext'
import { useOrg } from '../../context/OrgContext'
import { FF } from '../../theme/colors'

interface Props {
  open: boolean
  onClose: () => void
}

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Super Admin',
  admin:      'Admin',
  manager:    'Manager',
  employee:   'Field Worker',
}

export function UserProfileModal({ open, onClose }: Props) {
  const { user, logout } = useAuthContext()
  const { org } = useOrg()

  function handleSignOut() {
    if (!confirm('Sign out of FieldFlow?')) return
    onClose()
    logout()
  }

  return (
    <ModalShell open={open} onClose={onClose} size="sm">
      <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: FF.border }}>
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
            style={{ background: FF.purple }}
          >
            {(user?.name ?? 'U').charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="font-bold text-gray-900 text-sm">{user?.name ?? 'User'}</h2>
            <p className="text-[11px]" style={{ color: FF.textFaint }}>{ROLE_LABEL[user?.role ?? ''] ?? user?.role}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition">
          <X className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      <div className="px-5 py-4 space-y-3">
        <ProfileRow icon={<Phone className="w-4 h-4" />} label="Phone" value={user?.phone || '—'} />
        <ProfileRow icon={<ShieldCheck className="w-4 h-4" />} label="Role" value={ROLE_LABEL[user?.role ?? ''] ?? user?.role ?? '—'} />
        <ProfileRow icon={<Building2 className="w-4 h-4" />} label="Organization" value={org?.branding?.org_name || '—'} />
      </div>

      <div className="px-5 py-4 border-t" style={{ borderColor: FF.border }}>
        <button
          onClick={handleSignOut}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold border transition hover:bg-red-50"
          style={{ color: FF.red, borderColor: FF.redBg }}
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </ModalShell>
  )
}

function ProfileRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: FF.bg, color: FF.tealDark }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: FF.textFaint }}>{label}</p>
        <p className="text-sm font-semibold text-gray-800 truncate">{value}</p>
      </div>
    </div>
  )
}
