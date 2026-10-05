// lib/fileSafety.js — MIME checks for uploaded files (Document Vault, Media Library).
// Content is served same-origin from Postgres data: URLs with no sandboxing CDN, so the
// served MIME type is the only guard against script execution. Never trust the client's type.

// Executable as script/markup if served inline. Rejected at upload, re-checked at serve time.
const DANGEROUS_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
])

// Safe to render inline; anything else is served as an attachment.
const INLINE_SAFE_PREFIXES = ['image/', 'audio/', 'video/']
const INLINE_SAFE_EXACT = new Set(['application/pdf'])

function normalize(mimeType) {
  return (mimeType || '').toLowerCase().trim()
}

// Exactly one type/subtype token. The data: URL parser accepts anything up to
// the first ';', so values like 'application/pdf,text/html' reached storage;
// an exact-match denylist can't catch those, and browsers sniff the list.
const SINGLE_MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

// XML documents render as markup (an XHTML-namespaced text/xml file runs
// <script> same-origin), so they're as dangerous as text/html.
function isXmlMarkup(mt) {
  return mt === 'text/xml' || mt === 'application/xml' || mt === 'text/xsl' || mt.endsWith('+xml')
}

export function isDangerousMime(mimeType) {
  const mt = normalize(mimeType)
  if (!mt) return false
  if (!SINGLE_MIME_RE.test(mt)) return true
  return DANGEROUS_MIME_TYPES.has(mt) || isXmlMarkup(mt)
}

export function isInlineSafeMime(mimeType) {
  const mt = normalize(mimeType)
  if (!mt || isDangerousMime(mt)) return false
  return INLINE_SAFE_EXACT.has(mt) || INLINE_SAFE_PREFIXES.some(p => mt.startsWith(p))
}

// Content-Type to serve stored content with; old rows may hold dangerous or
// malformed types, which are downgraded to octet-stream.
export function safeServingContentType(mimeType) {
  const mt = normalize(mimeType)
  if (!mt || isDangerousMime(mt)) return 'application/octet-stream'
  return mt
}
