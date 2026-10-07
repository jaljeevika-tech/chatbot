import { apiFetch } from './apiFetch'

interface TemplateState { name: string; status: string; existed?: boolean; error?: string }

/** Creates (or finds) the quick-reply templates — Approve, Check in, Check out — on
 *  the org's WhatsApp Business Account (POST /api/wa/templates/approval). */
export async function createApprovalTemplate(lang: string): Promise<{ name: string; message: string; ok: boolean }> {
  const res = await apiFetch('/api/wa/templates/approval', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: lang || 'en' }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `Error ${res.status}`)
  const list: TemplateState[] = j.templates || []
  const line = (t: TemplateState) => t.error ? `${t.name}: failed — ${t.error}`
    : `${t.name}: ${t.existed ? 'already exists, ' : 'created, '}${t.status === 'APPROVED' ? 'approved' : t.status.toLowerCase()}`
  const waiting = list.some(t => t.status !== 'APPROVED' && !t.error)
  return {
    name: j.name,
    ok: !list.some(t => t.error),
    message: `${list.map(line).join(' · ')}.${waiting ? ' Meta usually approves within minutes to a few hours.' : ''} Click Save.`,
  }
}
