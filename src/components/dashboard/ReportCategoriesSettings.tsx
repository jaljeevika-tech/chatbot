import { useState } from 'react'
import { Save, Plus, X } from 'lucide-react'
import { useOrg } from '../../context/OrgContext'
import { apiFetch } from '../../utils/apiFetch'

export const DEFAULT_REPORT_CATEGORIES = [
  'Financial Report', 'Progress Report', 'Compliance Report', 'Audit Report',
  'M&E Report', 'Training Report', 'Assessment Report', 'Other',
]

interface Props {
  initialCategories: string[]
  token: string
}

export function ReportCategoriesSettings({ initialCategories, token }: Props) {
  const { loadOrg } = useOrg()
  const [categories, setCategories] = useState<string[]>(
    initialCategories.length ? initialCategories : DEFAULT_REPORT_CATEGORIES
  )
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function addCategory() {
    const name = draft.trim()
    if (!name || categories.includes(name)) return
    setCategories(prev => [...prev, name])
    setDraft('')
    setSaved(false)
  }

  function removeCategory(name: string) {
    setCategories(prev => prev.filter(c => c !== name))
    setSaved(false)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await apiFetch('/api/org/report-categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories }),
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
      <div className="px-5 pt-4 pb-2">
        <p className="text-[11px] text-gray-400">
          These categories appear as the "Report Category" picker when uploading a file to the Document Vault,
          and guide the AI's category + tag suggestions for each file.
        </p>
      </div>

      <div className="px-5 py-3 flex flex-wrap gap-2">
        {categories.map(name => (
          <span
            key={name}
            className="flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full text-xs font-semibold"
            style={{ background: '#F5F3FF', color: '#7C3AED' }}
          >
            {name}
            <button
              onClick={() => removeCategory(name)}
              className="p-0.5 rounded-full hover:bg-black/10 transition"
              title={`Remove "${name}"`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {categories.length === 0 && (
          <p className="text-xs text-gray-400">No categories yet — add one below.</p>
        )}
      </div>

      <div className="px-5 pb-4 flex gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory() } }}
          placeholder="e.g. Impact Story"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-purple-400"
        />
        <button
          onClick={addCategory}
          disabled={!draft.trim()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: '#7C3AED' }}
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      <div className="px-5 py-4 border-t border-gray-100 shrink-0 space-y-2">
        {error && <p className="text-xs text-red-500">{error}</p>}
        {saved && !saving && <p className="text-xs text-green-600 font-semibold">✓ Report categories saved</p>}
        <button
          onClick={save}
          disabled={saving || categories.length === 0}
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
