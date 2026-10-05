// Authenticated download: a plain <a href="/api/..."> can't send the Bearer token, so fetch
// the blob through apiFetch and save it via file-saver.

import { saveAs } from 'file-saver'
import { apiFetch } from './apiFetch'

export async function authedDownload(url: string, fallbackFilename: string): Promise<void> {
  const res = await apiFetch(url)
  if (!res.ok) {
    let msg = `Download failed (${res.status})`
    try { const j = await res.json(); if (j.error) msg = j.error } catch {}
    throw new Error(msg)
  }

  // Honour the server's Content-Disposition filename
  const cd = res.headers.get('Content-Disposition') || ''
  const match = /filename="?([^";]+)"?/i.exec(cd)
  const filename = match?.[1] || fallbackFilename

  const blob = await res.blob()
  saveAs(blob, filename)
}
