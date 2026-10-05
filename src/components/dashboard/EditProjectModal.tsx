// Admin "Edit Project" form (PUT /api/action-plans/:id/portfolio): NewProjectModal's fields,
// pre-filled from GET /api/action-plans/:id. Activities/targets still go through Upload Plan.

import { useEffect, useState } from 'react'
import { X, Loader2, AlertCircle, Pencil } from 'lucide-react'
import { apiFetch } from '../../utils/apiFetch'
import { FF } from '../../theme/colors'
import { useProjectContext } from '../../context/ProjectContext'
import { Field, inputClass, inputStyle, useLocationPicker, LocationPickerFields, locationEntryLabel, type LocationEntry } from './LocationPicker'

// GET /api/action-plans/:id: the action_plans row plus its action_plan_locations rows.
interface FetchedProject {
  id: string; name: string; year: number | null; start_month: number | null
  donor: string | null; budget: number | null; end_date: string | null
  health_override: 'green' | 'amber' | 'red' | null
  compliance_override: 'green' | 'amber' | 'red' | null
  locations_detail: {
    state_code: number | null; state_name: string | null
    district_code: number | null; district_name: string | null
    block_code: number | null; block_name: string | null
    panchayat_code: number | null; panchayat_name: string | null
    village_code: number | null; village_name: string | null
  }[]
}

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md flex flex-col" style={{ maxHeight: '92vh' }} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

function ModalHeader({ onClose, disabled }: { onClose: () => void; disabled: boolean }) {
  return (
    <div className="px-5 py-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: FF.border }}>
      <div className="flex items-center gap-2">
        <Pencil className="w-5 h-5" style={{ color: FF.purple }} />
        <h3 className="font-bold" style={{ color: FF.tealDark }}>Edit Project</h3>
      </div>
      <button onClick={onClose} disabled={disabled} className="disabled:opacity-50" style={{ color: FF.textFaint }}>
        <X className="w-5 h-5" />
      </button>
    </div>
  )
}

export function EditProjectModal({ projectId, onClose, onSaved }: {
  projectId: string
  onClose:   () => void
  onSaved:   (plan: { id: string; name: string }) => void
}) {
  const [loading, setLoading]     = useState(true)
  const [loadError, setLoadError] = useState('')
  const [initial, setInitial]     = useState<FetchedProject | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/action-plans/${projectId}`)
      .then(async r => {
        const d = await r.json()
        if (cancelled) return
        if (!r.ok) { setLoadError(d.error || 'Failed to load project'); setLoading(false); return }
        setInitial(d); setLoading(false)
      })
      .catch(e => { if (!cancelled) { setLoadError(e.message || 'Network error'); setLoading(false) } })
    return () => { cancelled = true }
  }, [projectId])

  if (loading) {
    return (
      <ModalShell onClose={onClose}>
        <ModalHeader onClose={onClose} disabled={false} />
        <div className="p-8 flex items-center justify-center overflow-y-auto" style={{ color: FF.textFaint }}>
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      </ModalShell>
    )
  }

  if (loadError || !initial) {
    return (
      <ModalShell onClose={onClose}>
        <ModalHeader onClose={onClose} disabled={false} />
        <div className="p-5 overflow-y-auto">
          <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-red-700 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{loadError || 'Failed to load project'}</span>
          </div>
        </div>
      </ModalShell>
    )
  }

  return <EditProjectForm projectId={projectId} initial={initial} onClose={onClose} onSaved={onSaved} />
}

function EditProjectForm({ projectId, initial, onClose, onSaved }: {
  projectId: string
  initial:   FetchedProject
  onClose:   () => void
  onSaved:   (plan: { id: string; name: string }) => void
}) {
  const { projects: existingProjects } = useProjectContext()

  const [name, setName]     = useState(initial.name)
  const [donor, setDonor]   = useState(initial.donor || '')
  const [start, setStart]   = useState(initial.year ? `${initial.year}-${String(initial.start_month || 4).padStart(2, '0')}-01` : '')
  const [end, setEnd]       = useState(initial.end_date ? initial.end_date.slice(0, 10) : '')
  const [budget, setBudget] = useState(initial.budget != null ? String(initial.budget) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const picker = useLocationPicker(
    initial.locations_detail.map((l): LocationEntry => ({
      stateCode: l.state_code, stateName: l.state_name || '',
      districtCode: l.district_code, districtName: l.district_name || '',
      blockCode: l.block_code, blockName: l.block_name || '',
      panchayatCode: l.panchayat_code, panchayatName: l.panchayat_name || '',
      villageCode: l.village_code, villageName: l.village_name || '',
    }))
  )

  // Block renaming onto another active project's name (this project excluded).
  const duplicate = existingProjects.find(
    p => p.active && p.id !== projectId && p.name.trim().toLowerCase() === name.trim().toLowerCase()
  ) || null

  const handleSave = async () => {
    if (!name.trim()) { setError('Project name is required'); return }
    if (duplicate) { setError(`A project named "${name.trim()}" already exists`); return }
    setSaving(true); setError('')
    try {
      const startDate = start ? new Date(start) : null
      const primary = picker.allLocations[0] ?? null
      const r = await apiFetch(`/api/action-plans/${projectId}/portfolio`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          year: startDate ? startDate.getFullYear() : initial.year,
          start_month: startDate ? startDate.getMonth() + 1 : initial.start_month,
          donor: donor.trim() || null,
          budget: budget ? Number(budget) : null,
          end_date: end || null,
          // Not editable here; passed through so admin-set pins survive the save.
          health_override: initial.health_override ?? null,
          compliance_override: initial.compliance_override ?? null,
          locations: picker.allLocations.map(locationEntryLabel).filter(Boolean),
          region: picker.allLocations.map(locationEntryLabel).filter(Boolean).join(' | ') || null,
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
      if (!r.ok) { setError(d.error || 'Failed to save changes'); setSaving(false); return }
      onSaved({ id: d.id, name: d.name })
    } catch (e: any) {
      setError(e.message || 'Network error')
      setSaving(false)
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader onClose={onClose} disabled={saving} />

      <div className="p-5 space-y-3 overflow-y-auto">
        <Field label="Project Name" required>
          <input className={inputClass} style={inputStyle} value={name} onChange={e => setName(e.target.value)}
            disabled={saving} />
        </Field>
        {duplicate && (
          <div className="rounded-xl p-3 flex items-center gap-2 text-xs" style={{ background: FF.amberBg, color: FF.amber }}>
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>A project named "{duplicate.name}" already exists — pick a different name.</span>
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
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
