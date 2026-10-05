// Shared LGD location picker (State/District/Block/Panchayat/Village), used by
// NewProjectModal and EditProjectModal. Each level is an independent multi-select;
// Block/Panchayat/Village searches are scoped to chosen parents because those tables
// are too large to search unscoped (see routes/lgd.routes.js).

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { FF } from '../../theme/colors'
import {
  fetchLgdStates, fetchLgdDistricts, fetchLgdBlocks, fetchLgdPanchayats, fetchLgdVillages,
  type LgdOption, type LgdState,
} from '../../utils/lgd'

export interface LocationEntry {
  stateCode:      number | null; stateName:      string
  districtCode:   number | null; districtName:   string
  blockCode:      number | null; blockName:      string
  panchayatCode:  number | null; panchayatName:  string
  villageCode:    number | null; villageName:    string
}

// `code` is null for free text that matched no LGD entry.
export interface LocationTag { code: number | null; name: string }

const emptyEntry = (): LocationEntry => ({
  stateCode: null, stateName: '', districtCode: null, districtName: '',
  blockCode: null, blockName: '', panchayatCode: null, panchayatName: '',
  villageCode: null, villageName: '',
})

function dedupeTags(tags: LocationTag[]): LocationTag[] {
  const seen = new Set<string>(); const out: LocationTag[] = []
  for (const t of tags) {
    const name = t.name.trim()
    if (!name) continue
    const key = t.code != null ? `c:${t.code}` : `n:${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key); out.push({ code: t.code, name })
  }
  return out
}

function dedupeOptions(list: LgdOption[]): LgdOption[] {
  const seen = new Set<number>(); const out: LgdOption[] = []
  for (const o of list) { if (!seen.has(o.code)) { seen.add(o.code); out.push(o) } }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Most-specific level first, for the legacy region/locations[] display string.
export function locationEntryLabel(e: LocationEntry): string {
  return [e.villageName, e.panchayatName, e.blockName, e.districtName, e.stateName]
    .map(s => s.trim()).filter(Boolean).join(', ')
}

// Exported so the project modals share this field styling.
export function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold mb-1" style={{ color: FF.textMuted }}>
        {label}{required && ' *'}
      </label>
      {children}
    </div>
  )
}

export const inputClass = 'w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2'
export const inputStyle = { border: `1.5px solid ${FF.border}`, color: FF.tealDark }

// Multi-select search that adds picks as tags. `options` is a preloaded list
// (State/District); `fetchOptions` a server typeahead for the big tables, where
// `allowFreeText` may add an unmatched value with a null code.
function LgdMultiSelect({ id, label, required, selected, onChange, disabled, placeholder, scopeHint, options, fetchOptions, allowFreeText }: {
  id:            string
  label:         string
  required?:     boolean
  selected:      LocationTag[]
  onChange:      (tags: LocationTag[]) => void
  disabled:      boolean
  placeholder:   string
  scopeHint?:    string
  options?:      LgdOption[]
  fetchOptions?: (q: string) => Promise<LgdOption[]>
  allowFreeText?: boolean
}) {
  const [query, setQuery]     = useState('')
  const [server, setServer]   = useState<LgdOption[]>([])
  const [open, setOpen]       = useState(false)

  const selectedCodes = useMemo(() => new Set(selected.filter(t => t.code != null).map(t => t.code)), [selected])
  const selectedNames = useMemo(() => new Set(selected.map(t => t.name.trim().toLowerCase())), [selected])

  // Typeahead mode: load an unfiltered batch once enabled, then re-query (debounced) as the user types.
  useEffect(() => {
    if (!fetchOptions || disabled) { setServer([]); return }
    fetchOptions('').then(setServer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, fetchOptions])

  useEffect(() => {
    if (!fetchOptions || disabled) return
    const t = setTimeout(() => { fetchOptions(query.trim()).then(setServer) }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = options
      ? options.filter(o => !q || o.name.toLowerCase().includes(q))
      : server
    return pool.filter(o => !selectedCodes.has(o.code)).slice(0, 50)
  }, [options, server, query, selectedCodes])

  const addTag = (tag: LocationTag) => {
    const name = tag.name.trim()
    if (!name) return
    if (tag.code != null && selectedCodes.has(tag.code)) return
    if (tag.code == null && selectedNames.has(name.toLowerCase())) return
    onChange([...selected, { code: tag.code, name }])
    setQuery(''); setOpen(false)
  }
  const removeTag = (i: number) => onChange(selected.filter((_, j) => j !== i))

  const exactMatch = matches.find(o => o.name.toLowerCase() === query.trim().toLowerCase())

  return (
    <Field label={label} required={required}>
      <div className="relative">
        <input
          className={inputClass} style={inputStyle}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            if (exactMatch) addTag({ code: exactMatch.code, name: exactMatch.name })
            else if (allowFreeText && query.trim()) addTag({ code: null, name: query.trim() })
          }}
          disabled={disabled}
          placeholder={disabled ? (scopeHint || 'Select the level above first') : placeholder}
        />
        {open && !disabled && matches.length > 0 && (
          <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-lg shadow-lg bg-white border" style={{ borderColor: FF.border }}>
            {matches.map(o => (
              <button type="button" key={o.code} onMouseDown={e => e.preventDefault()} onClick={() => addTag({ code: o.code, name: o.name })}
                className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50" style={{ color: FF.tealDark }}>
                {o.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {selected.map((t, i) => (
            <span key={`${id}-${t.code ?? 'x'}-${t.name}-${i}`} className="flex items-center gap-1 rounded-full pl-2.5 pr-1.5 py-1 text-xs" style={{ background: FF.borderFaint, color: FF.tealDark }}>
              {t.name}
              <button type="button" onClick={() => removeTag(i)} disabled={disabled} className="disabled:opacity-40" style={{ color: FF.textFaint }}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </Field>
  )
}

/** Owns the five selected-tag lists. `initialLocations` (EditProjectModal) is
 * decomposed into flat, deduped per-level tags; there is no chain to preserve. */
export function useLocationPicker(initialLocations: LocationEntry[] = []) {
  const [states, setStates]             = useState<LgdState[]>([])
  const [allDistricts, setAllDistricts] = useState<LgdOption[]>([])

  const [selectedStates, setSelectedStatesRaw]         = useState<LocationTag[]>(
    () => dedupeTags(initialLocations.map(e => ({ code: e.stateCode, name: e.stateName }))))
  const [selectedDistricts, setSelectedDistrictsRaw]   = useState<LocationTag[]>(
    () => dedupeTags(initialLocations.map(e => ({ code: e.districtCode, name: e.districtName }))))
  const [selectedBlocks, setSelectedBlocksRaw]         = useState<LocationTag[]>(
    () => dedupeTags(initialLocations.map(e => ({ code: e.blockCode, name: e.blockName }))))
  const [selectedPanchayats, setSelectedPanchayatsRaw] = useState<LocationTag[]>(
    () => dedupeTags(initialLocations.map(e => ({ code: e.panchayatCode, name: e.panchayatName }))))
  const [selectedVillages, setSelectedVillagesRaw]     = useState<LocationTag[]>(
    () => dedupeTags(initialLocations.map(e => ({ code: e.villageCode, name: e.villageName }))))

  const setSelectedStates     = (tags: LocationTag[]) => setSelectedStatesRaw(dedupeTags(tags))
  const setSelectedDistricts  = (tags: LocationTag[]) => setSelectedDistrictsRaw(dedupeTags(tags))
  const setSelectedBlocks     = (tags: LocationTag[]) => setSelectedBlocksRaw(dedupeTags(tags))
  const setSelectedPanchayats = (tags: LocationTag[]) => setSelectedPanchayatsRaw(dedupeTags(tags))
  const setSelectedVillages   = (tags: LocationTag[]) => setSelectedVillagesRaw(dedupeTags(tags))

  // State (36) and District (763) are small enough to load in full.
  useEffect(() => { fetchLgdStates().then(setStates) }, [])
  useEffect(() => { fetchLgdDistricts().then(setAllDistricts) }, [])

  const districtCodes  = useMemo(() => selectedDistricts.map(d => d.code).filter((c): c is number => c != null), [selectedDistricts])
  const blockCodes     = useMemo(() => selectedBlocks.map(b => b.code).filter((c): c is number => c != null), [selectedBlocks])
  const panchayatCodes = useMemo(() => selectedPanchayats.map(p => p.code).filter((c): c is number => c != null), [selectedPanchayats])

  // Block/Panchayat/Village search the union of all selected parent codes.
  const fetchBlockOptions = useMemo(
    () => (q: string) => districtCodes.length
      ? Promise.all(districtCodes.map(code => fetchLgdBlocks(code, q))).then(lists => dedupeOptions(lists.flat()))
      : Promise.resolve([]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [districtCodes.join(',')]
  )
  const fetchPanchayatOptions = useMemo(
    () => (q: string) => blockCodes.length
      ? Promise.all(blockCodes.map(code => fetchLgdPanchayats(code, q))).then(lists => dedupeOptions(lists.flat()))
      : Promise.resolve([]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blockCodes.join(',')]
  )
  const fetchVillageOptions = useMemo(
    () => (q: string) => {
      if (panchayatCodes.length) return Promise.all(panchayatCodes.map(code => fetchLgdVillages({ panchayatCode: code }, q))).then(lists => dedupeOptions(lists.flat()))
      if (blockCodes.length) return Promise.all(blockCodes.map(code => fetchLgdVillages({ blockCode: code }, q))).then(lists => dedupeOptions(lists.flat()))
      return Promise.resolve([])
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panchayatCodes.join(','), blockCodes.join(',')]
  )

  // Flat tags, each carrying only its own level; the backend tolerates partially-null rows.
  const allLocations = useMemo((): LocationEntry[] => [
    ...selectedStates.map(t => ({ ...emptyEntry(), stateCode: t.code, stateName: t.name })),
    ...selectedDistricts.map(t => ({ ...emptyEntry(), districtCode: t.code, districtName: t.name })),
    ...selectedBlocks.map(t => ({ ...emptyEntry(), blockCode: t.code, blockName: t.name })),
    ...selectedPanchayats.map(t => ({ ...emptyEntry(), panchayatCode: t.code, panchayatName: t.name })),
    ...selectedVillages.map(t => ({ ...emptyEntry(), villageCode: t.code, villageName: t.name })),
  ], [selectedStates, selectedDistricts, selectedBlocks, selectedPanchayats, selectedVillages])

  return {
    states, allDistricts,
    selectedStates, setSelectedStates,
    selectedDistricts, setSelectedDistricts,
    selectedBlocks, setSelectedBlocks,
    selectedPanchayats, setSelectedPanchayats,
    selectedVillages, setSelectedVillages,
    fetchBlockOptions, fetchPanchayatOptions, fetchVillageOptions,
    allLocations,
  }
}

export type LocationPicker = ReturnType<typeof useLocationPicker>

export function LocationPickerFields({ picker, disabled }: { picker: LocationPicker; disabled: boolean }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LgdMultiSelect id="lgd-picker-state" label="State" selected={picker.selectedStates} onChange={picker.setSelectedStates}
          disabled={disabled} placeholder="Search states…" options={picker.states} />
        <LgdMultiSelect id="lgd-picker-district" label="District" selected={picker.selectedDistricts} onChange={picker.setSelectedDistricts}
          disabled={disabled} placeholder="Search districts…" options={picker.allDistricts} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LgdMultiSelect id="lgd-picker-block" label="Block" selected={picker.selectedBlocks} onChange={picker.setSelectedBlocks}
          disabled={disabled || picker.selectedDistricts.length === 0} placeholder="Search blocks…"
          scopeHint="Select a district first" fetchOptions={picker.fetchBlockOptions} allowFreeText />
        <LgdMultiSelect id="lgd-picker-panchayat" label="Panchayat" selected={picker.selectedPanchayats} onChange={picker.setSelectedPanchayats}
          disabled={disabled || picker.selectedBlocks.length === 0} placeholder="Search panchayats…"
          scopeHint="Select a block first" fetchOptions={picker.fetchPanchayatOptions} allowFreeText />
      </div>
      <LgdMultiSelect id="lgd-picker-village" label="Village" selected={picker.selectedVillages} onChange={picker.setSelectedVillages}
        disabled={disabled || (picker.selectedBlocks.length === 0 && picker.selectedPanchayats.length === 0)} placeholder="Search villages…"
        scopeHint="Select a block or panchayat first" fetchOptions={picker.fetchVillageOptions} allowFreeText />
      <p className="text-[11px]" style={{ color: FF.textFaint }}>
        Pick as many States, Districts, Blocks, Panchayats and Villages as this project covers — each is added independently. Block/Panchayat/Village use official LGD codes; free text is also accepted.
      </p>
    </>
  )
}
