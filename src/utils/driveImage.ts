/** Drive file ID from /file/d/ID, /open?id=ID, /uc?id=ID or docs.google.com/.../d/ID URLs. */
export function extractDriveFileId(url: string): string | null {
  if (!url) return null

  const pathMatch = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/)
  if (pathMatch) return pathMatch[1]

  const paramMatch = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)
  if (paramMatch) return paramMatch[1]

  return null
}

/** Drive share URL → <img>-friendly thumbnail URL (`sz` = max dimension). */
export function getDriveThumbnailUrl(url: string, sz = 'w800'): string | null {
  const id = extractDriveFileId(url)
  if (!id) return null
  return `https://drive.google.com/thumbnail?id=${id}&sz=${sz}`
}

/** Drive share URL → direct-download URL. */
export function getDriveDownloadUrl(url: string): string | null {
  const id = extractDriveFileId(url)
  if (!id) return null
  return `https://drive.google.com/uc?export=download&id=${id}`
}
