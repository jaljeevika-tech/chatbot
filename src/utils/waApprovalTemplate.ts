import { apiFetch } from './apiFetch'

/** Creates (or finds) the "Approve" quick-reply template on the org's WhatsApp
 *  Business Account — POST /api/wa/templates/approval. Returns a status line. */
export async function createApprovalTemplate(lang: string): Promise<{ name: string; message: string }> {
  const res = await apiFetch('/api/wa/templates/approval', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: lang || 'en' }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `Error ${res.status}`)
  const state = j.status === 'APPROVED' ? 'approved and ready' : `${String(j.status).toLowerCase()} — Meta usually approves within minutes to a few hours`
  return { name: j.name, message: `Template “${j.name}” ${j.existed ? 'already exists' : 'created'}: ${state}. Click Save.` }
}
