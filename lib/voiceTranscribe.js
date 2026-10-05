// Downloads WhatsApp voice notes and transcribes them with Gemini 2.5 Flash (audio
// via inlineData), so the flow engine treats them like typed replies.

const GEMINI_FLASH_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'

function apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
}

/**
 * Download Meta-hosted media by media_id → { buffer, mimeType }, or null on failure.
 * GET /v18.0/{media_id} gives a signed URL, which is then fetched with the bearer token.
 */
export async function downloadMetaMedia(mediaId, accessToken) {
  if (!mediaId || !accessToken) return null
  try {
    // Step 1 — get the signed URL
    const metaRes = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!metaRes.ok) {
      console.warn('[voice] media meta fetch failed:', metaRes.status)
      return null
    }
    const meta = await metaRes.json()
    const url      = meta.url
    const mimeType = meta.mime_type || 'audio/ogg'
    if (!url) return null

    // Step 2 — fetch the binary
    const binRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!binRes.ok) {
      console.warn('[voice] media binary fetch failed:', binRes.status)
      return null
    }
    const arrayBuf = await binRes.arrayBuffer()
    return { buffer: Buffer.from(arrayBuf), mimeType }
  } catch (e) {
    console.warn('[voice] downloadMetaMedia error:', e.message)
    return null
  }
}

/**
 * Transcribe audio with Gemini 2.5 Flash; null on failure.
 * @param {string} hint  optional language hint, e.g. 'Hindi or English'
 */
export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg', hint = '') {
  const key = apiKey()
  if (!key || !audioBuffer) return null

  // Gemini wants the bare type, without "; codecs=opus".
  const cleanMime = mimeType.split(';')[0].trim()

  try {
    const base64 = audioBuffer.toString('base64')
    const userText = hint
      ? `Transcribe this audio verbatim. The speaker may be using ${hint}. Reply with ONLY the transcript text — no preamble, no quotation marks.`
      : 'Transcribe this audio verbatim. The speaker may be using Hindi, English, or a mix. Reply with ONLY the transcript text — no preamble, no quotation marks.'

    const res = await fetch(GEMINI_FLASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: cleanMime, data: base64 } },
            { text: userText },
          ],
        }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn('[voice] Gemini transcription failed:', res.status, errBody.slice(0, 200))
      return null
    }
    const data = await res.json()
    const parts = data?.candidates?.[0]?.content?.parts || []
    const text  = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()
    return text || null
  } catch (e) {
    console.warn('[voice] transcribeAudio error:', e.message)
    return null
  }
}
