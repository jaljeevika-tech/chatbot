import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Wand2, UserRound, Mail } from 'lucide-react'
import { useToast } from '../../../context/ToastContext'
import { saApi, errMsg, ApiError } from './api'
import type { OrgRow, OrgUser } from './types'
import { Button, Card, Dialog, Field, Input, Select, Badge, Skeleton, EmptyState, useConfirm, CopyButton } from './ui'

const ROLES = [
  { id: 'admin',    label: 'Admin',    hint: 'Manages users, settings and all data for the organisation.' },
  { id: 'manager',  label: 'Manager',  hint: 'Sees and approves their team’s work.' },
  { id: 'employee', label: 'Employee', hint: 'Field staff: submits reports and attendance.' },
]
const MIN_PASSWORD_LEN = 10
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

// Unambiguous characters (no 0/O, 1/l/I) so a password read out over the phone survives.
function generatePassword(len = 14) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  return Array.from(buf, n => chars[n % chars.length]).join('')
}

function PasswordField({ value, onChange, label, optional }: { value: string; onChange: (v: string) => void; label: string; optional?: boolean }) {
  const [generated, setGenerated] = useState('')
  return (
    <Field label={label} hint={generated && value === generated
      ? <span className="flex flex-wrap items-center gap-2">Share privately. It won't be shown again: <code className="text-sa-text select-all">{generated}</code><CopyButton text={generated} /></span>
      : optional ? `Leave blank to keep the current password. Minimum ${MIN_PASSWORD_LEN} characters.` : `Minimum ${MIN_PASSWORD_LEN} characters.`}>
      {id => (
        <div className="flex gap-2">
          <Input id={id} type="password" autoComplete="new-password" value={value} onChange={e => onChange(e.target.value)} />
          <Button type="button" icon={<Wand2 className="w-4 h-4" />} onClick={() => { const pw = generatePassword(); setGenerated(pw); onChange(pw) }}>Generate</Button>
        </div>
      )}
    </Field>
  )
}

type Draft = { id?: string; name: string; phone: string; email: string; role: string; password: string; access: 'invite' | 'password' }
const EMPTY: Draft = { name: '', phone: '', email: '', role: 'admin', password: '', access: 'invite' }
type LinkResult = { user: string; purpose: 'invite' | 'reset'; link: string; emailed: boolean; error?: string; email?: string }

export function OrgUsersTab({ org, onChanged }: { org: OrgRow; onChanged: () => void }) {
  const { toast } = useToast()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [users, setUsers] = useState<OrgUser[] | null>(null)
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [linkResult, setLinkResult] = useState<LinkResult | null>(null)
  const [sendingLink, setSendingLink] = useState<string | null>(null)

  const load = useCallback(() => {
    saApi<OrgUser[]>(`/api/superadmin/org/${org.id}/users`).then(setUsers).catch(e => toast(errMsg(e), 'error'))
  }, [org.id, toast])
  useEffect(load, [load])

  const sendLink = async (u: { id: string; name: string; email?: string | null }, purpose: 'invite' | 'reset') => {
    setSendingLink(u.id)
    try {
      const r = await saApi<{ link: string; emailed: boolean; error?: string }>(`/api/superadmin/org/${org.id}/users/${u.id}/send-link`, { method: 'POST', body: { purpose } })
      setLinkResult({ user: u.name, purpose, email: u.email ?? undefined, ...r })
    } catch (e) { toast(errMsg(e), 'error') }
    finally { setSendingLink(null) }
  }

  const isEdit = !!draft?.id
  const save = async () => {
    if (!draft) return
    const email = draft.email.trim()
    const wantsInvite = !isEdit && draft.access === 'invite'
    if (!draft.name.trim() || (!isEdit && !draft.phone.trim())) { setFormError('Name and phone are required'); return }
    if (email && !EMAIL_RE.test(email)) { setFormError('Enter a valid email address'); return }
    if (wantsInvite && !email) { setFormError('An email address is needed to send an invite. Or choose “Set a password now”.'); return }
    if (!isEdit && !wantsInvite && !draft.password) { setFormError('Set a password, or generate one'); return }
    if (draft.password && draft.password.length < MIN_PASSWORD_LEN) { setFormError(`Password must be at least ${MIN_PASSWORD_LEN} characters`); return }
    setSaving(true); setFormError('')
    try {
      if (isEdit) {
        await saApi(`/api/superadmin/org/${org.id}/users/${draft.id}`, {
          method: 'PATCH', body: { name: draft.name, role: draft.role, email, ...(draft.password ? { password: draft.password } : {}) },
        })
        toast(draft.password ? 'User updated and signed out of other sessions' : 'User updated')
      } else {
        const body = { name: draft.name, phone: draft.phone, role: draft.role, email, password: wantsInvite ? '' : draft.password }
        let created: { id: string }
        try {
          created = await saApi<{ id: string }>(`/api/superadmin/org/${org.id}/users`, { method: 'POST', body })
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'SEAT_LIMIT') throw e
          const ok = await confirm({ title: 'Seat limit reached', body: `${e.message} Adding this user will put the organisation over its plan.`, confirmLabel: 'Add anyway' })
          if (!ok) return
          created = await saApi<{ id: string }>(`/api/superadmin/org/${org.id}/users`, { method: 'POST', body: { ...body, override_seat_limit: true } })
        }
        toast(`${draft.name} added`)
        if (wantsInvite) await sendLink({ id: created.id, name: draft.name, email }, 'invite')
      }
      setDraft(null); load(); onChanged()
    } catch (e) { setFormError(errMsg(e)) }
    finally { setSaving(false) }
  }

  const remove = async (u: OrgUser) => {
    const ok = await confirm({
      title: `Remove ${u.name}?`, danger: true, confirmLabel: 'Remove user',
      body: 'They are signed out everywhere and can no longer log in. Users who have submitted reports or approvals can’t be removed. Change their role or reset their password instead.',
    })
    if (!ok) return
    try {
      await saApi(`/api/superadmin/org/${org.id}/users/${u.id}`, { method: 'DELETE' })
      toast(`${u.name} removed`); load(); onChanged()
    } catch (e) { toast(errMsg(e), 'error') }
  }

  const filtered = (users ?? []).filter(u => !q.trim() || `${u.name} ${u.phone} ${u.email ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
  const roleTone = (r: string) => r === 'admin' ? 'primary' as const : r === 'manager' ? 'success' as const : 'neutral' as const

  return (
    <>
      <Card padded={false}
        title={`${users?.length ?? '…'} user${users?.length === 1 ? '' : 's'}`}
        description={org.max_users != null && org.max_users < 9999 ? `Plan allows ${org.max_users} seats.` : 'No seat limit on this plan.'}
        actions={<>
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" className="w-36 sm:w-48 py-1.5" aria-label="Search users" />
          <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setFormError(''); setDraft({ ...EMPTY }) }}>Add user</Button>
        </>}>
        {!users ? <div className="p-5 flex flex-col gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
          : filtered.length === 0 ? (
            <EmptyState icon={<UserRound className="w-8 h-8" />} title={users.length ? 'No matches' : 'No users yet'}>
              {users.length ? 'Try another search.' : 'Add the organisation’s first admin so they can sign in and invite their team.'}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-sa-border">
              {filtered.map(u => (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-sa-text flex items-center gap-2">{u.name}<Badge tone={roleTone(u.role)}>{u.role}</Badge></div>
                    <div className="text-xs text-sa-muted">
                      <span className="font-mono">{u.phone}</span>{u.email && <> · {u.email}</>}
                      {!u.has_password && <span className="text-sa-warning"> · no password yet</span>}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" icon={<Mail className="w-3.5 h-3.5" />} loading={sendingLink === u.id}
                      title={u.email ? `Email a link to ${u.email}` : 'No email on file: creates a link you can share yourself'}
                      onClick={() => sendLink(u, u.has_password ? 'reset' : 'invite')}>
                      {u.has_password ? 'Reset link' : 'Invite link'}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Pencil className="w-3.5 h-3.5" />}
                      onClick={() => { setFormError(''); setDraft({ id: u.id, name: u.name, phone: u.phone, email: u.email ?? '', role: u.role, password: '', access: 'password' }) }}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => remove(u)} aria-label={`Remove ${u.name}`} />
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Dialog open={!!draft} onClose={() => setDraft(null)} title={isEdit ? `Edit ${draft?.name}` : 'Add user'}
        description={isEdit ? 'Changing the role or password signs the user out of all devices.' : `They sign in at ${window.location.origin}/?org=${org.slug} with their phone number and password.`}
        footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>{isEdit ? 'Save changes' : draft?.access === 'invite' ? 'Add and send invite' : 'Add user'}</Button></>}>
        {draft && (
          <div className="flex flex-col gap-4">
            <Field label="Full name">{id => <Input id={id} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} autoFocus />}</Field>
            <Field label="Phone" hint={isEdit ? 'The phone number is the login ID and can’t be changed.' : 'A 10-digit number is treated as Indian (+91). For other countries, include the country code.'}>
              {id => <Input id={id} type="tel" value={draft.phone} disabled={isEdit} onChange={e => setDraft({ ...draft, phone: e.target.value })} />}
            </Field>
            <Field label={isEdit ? 'Email' : 'Email (recommended)'} hint="Used for invite and password-reset links.">
              {id => <Input id={id} type="email" value={draft.email} placeholder="name@ngo.org" onChange={e => setDraft({ ...draft, email: e.target.value })} />}
            </Field>
            <Field label="Role" hint={ROLES.find(r => r.id === draft.role)?.hint}>
              {id => (
                <Select id={id} value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value })}>
                  {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </Select>
              )}
            </Field>
            {!isEdit && (
              <div role="radiogroup" aria-label="How they get a password" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([['invite', 'Email an invite', 'They choose their own password from a link (valid 72 hours).'], ['password', 'Set a password now', 'You share it with them yourself.']] as const).map(([v, t, d]) => (
                  <button key={v} type="button" role="radio" aria-checked={draft.access === v} onClick={() => setDraft({ ...draft, access: v })}
                    className={`text-left rounded-lg border p-3 cursor-pointer transition-colors ${draft.access === v ? 'border-sa-primary bg-sa-primary-soft' : 'border-sa-border hover:bg-sa-subtle'}`}>
                    <div className="text-sm font-semibold text-sa-text">{t}</div>
                    <div className="text-xs text-sa-muted mt-0.5">{d}</div>
                  </button>
                ))}
              </div>
            )}
            {(isEdit || draft.access === 'password') && (
              <PasswordField label={isEdit ? 'New password' : 'Password'} optional={isEdit} value={draft.password} onChange={v => setDraft({ ...draft, password: v })} />
            )}
            {formError && <div className="rounded-lg bg-sa-danger-soft text-sa-danger text-sm px-3 py-2">{formError}</div>}
          </div>
        )}
      </Dialog>
      {confirmDialog}

      <Dialog open={!!linkResult} onClose={() => setLinkResult(null)}
        title={linkResult?.emailed ? `${linkResult.purpose === 'invite' ? 'Invite' : 'Reset link'} sent` : `${linkResult?.purpose === 'invite' ? 'Invite' : 'Reset'} link for ${linkResult?.user ?? ''}`}
        footer={<Button variant="primary" onClick={() => setLinkResult(null)}>Done</Button>}>
        {linkResult && (
          <div className="flex flex-col gap-3 text-sm">
            {linkResult.emailed
              ? <p className="text-sa-text">Emailed to <strong>{linkResult.email}</strong>. The link works once and expires in {linkResult.purpose === 'invite' ? '72 hours' : '2 hours'}.</p>
              : <p className="rounded-lg bg-sa-warning-soft text-sa-warning px-3 py-2">Not emailed: {linkResult.error} Share the link below privately instead, e.g. on WhatsApp.</p>}
            <div className="flex gap-2 items-center">
              <code className="flex-1 min-w-0 truncate rounded-lg bg-sa-subtle border border-sa-border px-3 py-2 text-xs text-sa-text">{linkResult.link}</code>
              <CopyButton text={linkResult.link} />
            </div>
            <p className="text-xs text-sa-muted">Anyone with this link can set this user’s password, so only send it to them.</p>
          </div>
        )}
      </Dialog>
    </>
  )
}
