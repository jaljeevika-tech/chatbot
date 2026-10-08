// Adds one MIS record for a single beneficiary from their profile, the single-record
// counterpart of the bulk Excel uploads. POSTs to /api/beneficiary-profile/:uid/mis/:category,
// which re-resolves the beneficiary; this form supplies the fields and the project.

import { useState } from 'react'
import { X, Loader2, AlertCircle, PlusCircle } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { useProjectContext } from '../../context/ProjectContext'
import { FF } from '../../theme/colors'

export interface InterventionFieldConfig {
  key: string // literal DB column name — matches MIS_WRITERS in routes/beneficiary-profile.routes.js
  label: string
  type: 'text' | 'date' | 'number' | 'select'
  options?: string[] // required when type is 'select' — fixed choices, e.g. Income's Source dropdown
  required?: boolean
}

export interface InterventionCategoryConfig {
  apiCategory: string // BeneficiaryMisData key, e.g. 'training' — also the :category URL segment
  title: string        // matches the noun used in MisTable's own heading on this page
  fields: InterventionFieldConfig[]
}

// Same eight categories, same order, as BeneficiaryProfileDetail's MisTable list.
export const INTERVENTION_CATEGORIES: InterventionCategoryConfig[] = [
  {
    apiCategory: 'training', title: 'Training',
    fields: [
      { key: 'training_topic', label: 'Training Topic', type: 'text', required: true },
      { key: 'training_date', label: 'Date', type: 'date' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  {
    apiCategory: 'inputDistribution', title: 'Input Distribution',
    fields: [
      { key: 'input_distributed', label: 'Input Distributed', type: 'text', required: true },
      { key: 'quantity', label: 'Quantity', type: 'number' },
      { key: 'unit', label: 'Unit (No., Kg, Pc…)', type: 'text' },
      { key: 'distribution_date', label: 'Date', type: 'date' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  {
    apiCategory: 'schemeAccess', title: 'Scheme Access',
    fields: [
      { key: 'scheme_name', label: 'Scheme', type: 'text', required: true },
      { key: 'access_date', label: 'Date', type: 'date' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  {
    apiCategory: 'creditGrantAccess', title: 'Credit/Grant Access',
    fields: [
      { key: 'credit_grant_source', label: 'Source', type: 'text', required: true },
      { key: 'credit_grant_type', label: 'Type', type: 'text' },
      { key: 'entity_name', label: 'Entity Name', type: 'text' },
      { key: 'amount', label: 'Amount (₹)', type: 'number' },
      { key: 'access_date', label: 'Date', type: 'date' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  {
    apiCategory: 'businessDevelopmentSupport', title: 'Business Development Support',
    fields: [
      { key: 'support_provided', label: 'Support Provided', type: 'text', required: true },
      { key: 'support_date', label: 'Date', type: 'date' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  {
    apiCategory: 'complianceSupport', title: 'Compliance Support',
    fields: [
      { key: 'compliance_support_provided', label: 'Support Provided', type: 'text', required: true },
      { key: 'support_date', label: 'Date', type: 'date' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  {
    apiCategory: 'exposureVisit', title: 'Exposure Visit',
    fields: [
      { key: 'purpose', label: 'Purpose', type: 'text', required: true },
      { key: 'visit_place', label: 'Place of Visit', type: 'text' },
      { key: 'visit_date', label: 'Date', type: 'date' },
    ],
  },
  {
    apiCategory: 'income', title: 'Income',
    fields: [
      { key: 'financial_year', label: 'Financial Year', type: 'text', required: true },
      { key: 'income_source', label: 'Source', type: 'select', required: true, options: ['Fisheries', 'Agriculture', 'Horticulture', 'Livestock', 'Trade', 'Service', 'Labour', 'Other'] },
      { key: 'income_realised', label: 'Income Realised (₹)', type: 'number' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
]

export function AddInterventionModal({ uid, category, onClose, onSaved }: {
  uid: string
  category: InterventionCategoryConfig
  onClose: () => void
  onSaved: () => void
}) {
  const { projects, selectedProjectKey } = useProjectContext()
  const [projectKey, setProjectKey] = useState(selectedProjectKey || '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const setField = (key: string, v: string) => setValues(prev => ({ ...prev, [key]: v }))

  const handleSubmit = async () => {
    if (!projectKey) { setError('Select which project this record belongs to'); return }
    const missing = category.fields.find(f => f.required && !String(values[f.key] || '').trim())
    if (missing) { setError(`${missing.label} is required`); return }

    setSaving(true); setError('')
    try {
      const body: Record<string, unknown> = { project_key: projectKey }
      for (const f of category.fields) {
        const raw = values[f.key]
        body[f.key] = raw != null && raw !== '' ? raw : null
      }
      const r = await apiFetch(`/api/beneficiary-profile/${encodeURIComponent(uid)}/mis/${category.apiCategory}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Could not save record'); setSaving(false); return }
      onSaved()
    } catch (e: any) {
      setError(e.message || 'Network error')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: FF.border }}>
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5" style={{ color: FF.purple }} />
            <h3 className="font-bold" style={{ color: FF.tealDark }}>Add {category.title} Record</h3>
          </div>
          <button onClick={onClose} disabled={saving} className="disabled:opacity-50" style={{ color: FF.textFaint }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: FF.tealDark }}>Project *</label>
            <select
              value={projectKey}
              onChange={e => setProjectKey(e.target.value)}
              disabled={saving}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
            >
              <option value="">Select a project…</option>
              {projects.map(p => <option key={p.project_key} value={p.project_key}>{p.name}</option>)}
            </select>
          </div>

          {category.fields.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-semibold mb-1" style={{ color: FF.tealDark }}>
                {f.label}{f.required ? ' *' : ''}
              </label>
              {f.type === 'select' ? (
                <select
                  value={values[f.key] || ''}
                  onChange={e => setField(f.key, e.target.value)}
                  disabled={saving}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
                >
                  <option value="">Select…</option>
                  {(f.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <input
                  type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                  value={values[f.key] || ''}
                  onChange={e => setField(f.key, e.target.value)}
                  disabled={saving}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                  style={{ border: `1.5px solid ${FF.border}`, color: FF.tealDark }}
                />
              )}
            </div>
          ))}

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 rounded-xl text-sm font-semibold border disabled:opacity-50"
              style={{ borderColor: FF.border, color: FF.textMuted }}>
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: FF.purple }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5" />}
              {saving ? 'Saving…' : 'Save Record'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
