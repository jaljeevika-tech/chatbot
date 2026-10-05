// Text extraction for Document Vault uploads (PDF/DOCX/XLSX/PPTX and other
// officeparser formats) so files can ground an AI chat. Independent of Notebook's
// pdf-parse path in notebook.routes.js.

import { parseOffice } from 'officeparser'

// Legacy binary .doc/.xls/.ppt must not map to their XML counterparts — that would
// feed a binary file to officeparser's zip/XML parser.
const MIME_TO_TYPE = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/rtf': 'rtf',
}

const EXT_TO_TYPE = {
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx',
  odt: 'odt', ods: 'ods', odp: 'odp',
  csv: 'csv', md: 'md', html: 'html', htm: 'html', rtf: 'rtf',
}

function resolveFileType(mimeType, name) {
  if (mimeType && MIME_TO_TYPE[mimeType]) return MIME_TO_TYPE[mimeType]
  const ext = String(name || '').split('.').pop()?.toLowerCase()
  return EXT_TO_TYPE[ext] || null
}

/** Plain text for AI grounding; null when unsupported or extraction fails (view/download only). */
export async function extractText(buffer, mimeType, name) {
  const fileType = resolveFileType(mimeType, name)
  if (!fileType) return null
  try {
    const ast = await parseOffice(buffer, { fileType })
    // Badly-mapped PDF fonts yield NUL/control characters, which PostgreSQL TEXT rejects.
    const text = ast.toText().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
    // 500k chars is plenty for grounding a chat
    return text.length > 0 ? text.slice(0, 500_000) : null
  } catch (e) {
    console.warn('[extractDocumentText]', e instanceof Error ? e.message : e)
    return null
  }
}
