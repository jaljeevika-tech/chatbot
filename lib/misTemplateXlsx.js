// Shared "Download Template" builder for the MIS category upload modals: one data
// sheet with the exact header row its parser expects plus samples, and a README sheet.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Every MIS template's data sheet is named "Project Name_MIS Activity Name_Month"
// (e.g. "Jal Jeevika_Training_September", month at download time). Strips characters
// Excel forbids in sheet names; buildTemplateXlsx caps the length at 31.
export function misSheetName(projectName, activityName, date = new Date()) {
  const month = MONTH_NAMES[date.getMonth()]
  const raw = `${projectName}_${activityName}_${month}`
  return raw.replace(/[:\\/?*[\]]/g, '-')
}

// Templates only get project_key; the display name is action_plans.name. Falls back
// to the key (or 'Project'), as beneficiary-profile does.
export async function resolveProjectName(pool, orgId, projectKey) {
  if (!projectKey) return 'Project'
  const { rows } = await pool.query(
    `SELECT name FROM action_plans WHERE org_id = $1 AND project_key = $2`,
    [orgId, projectKey]
  )
  return rows[0]?.name || projectKey
}

export async function buildTemplateXlsx({ sheetName, header, sampleRows, readmeLines }) {
  const XLSX = (await import('xlsx')).default
  const wb = XLSX.utils.book_new()

  const aoa = [header, ...sampleRows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = header.map(h => ({ wch: Math.min(Math.max(String(h).length, 10), 32) }))
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).slice(0, 31))

  const wsReadme = XLSX.utils.aoa_to_sheet(readmeLines.map(line => [line]))
  wsReadme['!cols'] = [{ wch: 100 }]
  XLSX.utils.book_append_sheet(wb, wsReadme, 'README')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

export function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(buf)
}
