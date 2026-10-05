// Article extraction for Notebook's "Add URL" source: Readability (Firefox Reader
// Mode's engine) on jsdom drops nav, banners and ads. Pure JS, runs in-process.

import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

/** Clean { title, text } from raw HTML; null when no article is found (callers fall back to cruder extraction). */
export function extractArticle(html, url) {
  try {
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document).parse()
    const text = article?.textContent?.replace(/\s{2,}/g, ' ').trim()
    if (!text) return null
    return { title: article.title?.trim() || null, text }
  } catch (e) {
    console.warn('[extractWebArticle]', e instanceof Error ? e.message : e)
    return null
  }
}
