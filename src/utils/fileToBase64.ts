/** A file's bytes as base64 (no "data:" prefix) via the browser's encoder. Not
 *  `btoa(String.fromCharCode(...bytes))`: spreading the bytes overflows the stack past ~120 KB. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result || '')
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
    reader.readAsDataURL(file)
  })
}
