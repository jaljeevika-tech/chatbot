// SQL for a registry row's effective Production System array (067/068/069), matching
// beneficiary-dashboard's productionEntries: production_systems when a non-empty
// array; else the legacy production_type + current_production_ton (×10 to Quintal)
// where those columns exist; else []. The jsonb_typeof guard keeps a malformed
// value from making jsonb_array_elements() throw.

export function effectiveProductionSystemsSql(alias, { legacy = false } = {}) {
  const p = alias ? `${alias}.` : ''
  const legacyBranch = legacy
    ? `WHEN ${p}production_type IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
         'type', ${p}production_type, 'production_quintal', ${p}current_production_ton * 10))`
    : ''
  return `(CASE
    WHEN jsonb_typeof(${p}production_systems) = 'array' AND jsonb_array_length(${p}production_systems) > 0 THEN ${p}production_systems
    ${legacyBranch}
    ELSE '[]'::jsonb END)`
}

// Per-type KPI columns over a `ps` LATERAL expansion (alias.id is the
// registry row's id) — same four systems as the registration forms.
export function productionKpiColumnsSql(alias) {
  return `count(DISTINCT ${alias}.id) FILTER (WHERE ps.type = 'Aquaculture')::int  AS aquaculture,
          count(DISTINCT ${alias}.id) FILTER (WHERE ps.type = 'Agriculture')::int  AS agriculture,
          count(DISTINCT ${alias}.id) FILTER (WHERE ps.type = 'Livestock')::int    AS livestock,
          count(DISTINCT ${alias}.id) FILTER (WHERE ps.type = 'Horticulture')::int AS horticulture,
          coalesce(sum((ps.entry->>'production_quintal')::numeric) FILTER (WHERE ps.type = 'Aquaculture'), 0)  AS aquaculture_qtl,
          coalesce(sum((ps.entry->>'production_quintal')::numeric) FILTER (WHERE ps.type = 'Agriculture'), 0)  AS agriculture_qtl,
          coalesce(sum((ps.entry->>'production_quintal')::numeric) FILTER (WHERE ps.type = 'Horticulture'), 0) AS horticulture_qtl,
          coalesce(sum((ps.entry->>'production_quintal')::numeric), 0) AS total_production,
          coalesce(sum((ps.entry->>'livestock_count')::numeric), 0)    AS total_livestock`
}

// The kpis fields those columns map to — spread into each list route's
// `kpis` object so all three registries expose the same production keys.
export function productionKpis(row) {
  return {
    aquaculture:     row.aquaculture || 0,
    agriculture:     row.agriculture || 0,
    livestock:       row.livestock || 0,
    horticulture:    row.horticulture || 0,
    aquacultureQtl:  Number(row.aquaculture_qtl) || 0,
    agricultureQtl:  Number(row.agriculture_qtl) || 0,
    horticultureQtl: Number(row.horticulture_qtl) || 0,
    totalProduction: Number(row.total_production) || 0, // Quintal — Livestock is a headcount, not summed here
    totalLivestock:  Number(row.total_livestock) || 0,
  }
}
