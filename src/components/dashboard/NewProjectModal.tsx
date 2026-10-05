// "+ New Project" form: creates an action_plans shell (name, donor, dates, budget, location)
// with no activities; "Upload Plan" later adds them without touching these fields.

import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, AlertCircle, FolderPlus } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { useOrg } from '../../context/OrgContext'
import { useProjectContext } from '../../context/ProjectContext'
import { Field, inputClass, inputStyle, useLocationPicker, LocationPickerFields, locationEntryLabel } from './LocationPicker'

export function NewProjectModal({ onClose, onCreated }: {
  onClose:    () => void
  onCreated:  (plan: { id: string; name: string }) => void
}) {
  const { org } = useOrg()
  const projects = org?.projects ?? []
  const { projects: existingProjects } = useProjectContext()

  // Settings → Projects labels ∪ live action_plans names, deduped case-insensitively.
  const nameOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const label of [
      ...projects.map(p => p.label),
      ...existingProjects.filter(p => p.active).map(p => p.name),
    ]) {
      const key = label.trim().toLowerCase()
      if (key && !seen.has(key)) { seen.add(key); out.push(label.trim()) }
    }
    return out.sort((a, b) => a.localeCompare(b))
  }, [projects, existingProjects])

  const [name, setName]         = useState('')
  const [donor, setDonor]       = useState('')
  const [start, setStart]       = useState('')
  const [end, setEnd]           = useState('')
  const [budget, setBudget]     = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  const picker = useLocationPicker()

  // A name matching a live project: block creating a second, disconnected row.
  const duplicate = existingProjects.find(
    p => p.active && p.name.trim().toLowerCase() === name.trim().toLowerCase()
  ) || null

  // Pre-fill untouched fields from the duplicate so the user sees what already exists.
  useEffect(() => {
    if (!duplicate) return
    setDonor(v => v || duplicate.donor || '')
    setEnd(v => v || duplicate.end_date || '')
    setBudget(v => v || (duplicate.budget != null ? String(duplicate.budget) : ''))
    // Location isn't pre-filled: duplicate.region is a flattened string with no way back to LGD codes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicate?.id])

  const handleSave = async () => {
    if (!name.trim()) { setError('Project name is required'); return }
    if (duplicate) { setError(`A project named "${name.trim()}" already exists`); return }
    setSaving(true); setError('')
    try {
      const startDate = start ? new Date(start) : null
      // Reuse a matching Settings → Projects id as the project_key base, keeping action_plans
      // in sync with organizations.metadata.projects.
      const matched = projects.find(p => p.label.trim().toLowerCase() === name.trim().toLowerCase())
      const primary = picker.allLocations[0] ?? null
      const r = await apiFetch('/api/action-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          year: startDate ? startDate.getFullYear() : new Date().getFullYear(),
          start_month: startDate ? startDate.getMonth() + 1 : 4,
          locations: picker.allLocations.map(locationEntryLabel).filter(Boolean),
          activities: [],
          donor: donor.trim() || null,
          region: picker.allLocations.map(locationEntryLabel).filter(Boolean).join(' | ') || null,
          budget: budget ? Number(budget) : null,
          end_date: end || null,
          project_id: matched?.id ?? null,
          location_state_code: primary?.stateCode ?? null, location_state_name: primary?.stateName.trim() || null,
          location_district_code: primary?.districtCode ?? null, location_district_name: primary?.districtName.trim() || null,
          location_block_code: primary?.blockCode ?? null, location_block_name: primary?.blockName.trim() || null,
          location_panchayat_code: primary?.panchayatCode ?? null, location_panchayat_name: primary?.panchayatName.trim() || null,
          location_village_code: primary?.villageCode ?? null, location_village_name: primary?.villageName.trim() || null,
          locations_detail: picker.allLocations.map(l => ({
            state_code: l.stateCode, state_name: l.stateName.trim() || null,
            district_code: l.districtCode, district_name: l.districtName.trim() || null,
            block_code: l.blockCode, block_name: l.blockName.trim() || null,
            panchayat_code: l.panchayatCode, panchayat_name: l.panchayatName.trim() || null,
            village_code: l.villageCode, village_name: l.villageName.trim() || null,
          })),
        }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Failed to create project'); setSaving(false); return }
      onCreated({ id: d.id, name: d.name })
    } catch (e: any) {
      setError(e.message || 'Network error')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md flex flex-col" style={{ maxHeight: '92vh' }} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: FF.border }}>
          <div className="flex items-center gap-2">
            <FolderPlus className="w-5 h-5" style={{ color: FF.purple }} />
            <h3 className="font-bold" style={{ color: FF.tealDark }}>New Project</h3>
          </div>
          <button onClick={onClose} disabled={saving} className="disabled:opacity-50" style={{ color: FF.textFaint }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          <Field label="Project Name" required>
            <input className={inputClass} style={inputStyle} value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Sustainable Fisheries Livelihood Program" disabled={saving}
              list={nameOptions.length ? 'new-project-name-options' : undefined} />
            {nameOptions.length > 0 && (
              <datalist id="new-project-name-options">
                {nameOptions.map(label => <option key={label} value={label} />)}
              </datalist>
            )}
          </Field>
          {duplicate && (
            <div className="rounded-xl p-3 flex items-center gap-2 text-xs" style={{ background: FF.amberBg, color: FF.amber }}>
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>A project named "{duplicate.name}" already exists — its details are shown below, but a duplicate can't be created.</span>
            </div>
          )}
          <Field label="Donor / Philanthropic Organisation">
            <input className={inputClass} style={inputStyle} value={donor} onChange={e => setDonor(e.target.value)}
              placeholder="e.g. Azim Premji Philanthropic Initiatives" disabled={saving} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Start Date">
              <input type="date" className={inputClass} style={inputStyle} value={start} onChange={e => setStart(e.target.value)} disabled={saving} />
            </Field>
            <Field label="End Date">
              <input type="date" className={inputClass} style={inputStyle} value={end} onChange={e => setEnd(e.target.value)} disabled={saving} />
            </Field>
          </div>
          <Field label="Total Budget (₹)">
            <input type="number" className={inputClass} style={inputStyle} value={budget} onChange={e => setBudget(e.target.value)}
              placeholder="e.g. 4500000" disabled={saving} />
          </Field>

          <LocationPickerFields picker={picker} disabled={saving} />

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <p className="text-[11px]" style={{ color: FF.textFaint }}>
            This creates the project. Open its <strong>Action Plan</strong> tab afterward and use <strong>⚙ Manage → Upload Plan</strong> to add its activities and targets from an Excel sheet.
          </p>

          <div className="flex justify-end gap-2 pt-1 flex-wrap">
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 rounded-xl text-sm font-semibold border disabled:opacity-50"
              style={{ borderColor: FF.border, color: FF.textMuted }}>
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !!duplicate}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: FF.purple }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
              {saving ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
