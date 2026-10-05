/** Run `fn` over `items` with at most `limit` calls in flight at once. Used for
 *  per-turn TTS: firing 40-60 voice requests simultaneously trips Gemini's
 *  per-minute quota and the server rate limiter, silently dropping lines. */
export async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}