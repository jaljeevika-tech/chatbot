// Notebook AI routes (stateless, no DB). With NOTEBOOK_SERVICE_URL set, most
// requests are proxied to the Cloud Run notebook service; otherwise handled here.

import { Router } from 'express'
import { setupSSE, sendSSE, callGeminiNotebook, makeAbortSignal } from '../lib/gemini.js'
import { CircuitBreaker } from '../lib/circuitBreaker.js'
import { getOrgPrompt } from '../lib/promptStore.js'
import { trackUsage } from '../lib/usageTracker.js'
import { buildOrgContext } from '../lib/aiContext.js'
import { getOrgSector } from '../lib/orgMetaCache.js'
import { sectorOverlay } from '../lib/prompts/sectorPrompts.js'
import { extractText } from '../lib/extractDocumentText.js'
import { extractArticle } from '../lib/extractWebArticle.js'
import { synthesizeSpeech } from '../lib/tts.js'
import { checkPublicUrl } from '../lib/ssrfGuard.js'

const router = Router()

// ── Cloud Run proxy ──────────────────────────────────────────────────────────
// Falls through to the local handlers when NOTEBOOK_SERVICE_URL is unset or the breaker is open.
const notebookCB = new CircuitBreaker('notebook-service')

/** OIDC identity token for Cloud Run via the GCP metadata server; null off GCP. */
async function getCloudRunIdToken(audience) {
  try {
    const metaRes = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
    )
    if (metaRes.ok) return await metaRes.text()
  } catch { /* not on GCP — local dev */ }
  return null
}

// Always served here: the CI deploy only ships App Engine, so Cloud Run copies of
// these (podcast/video scripts, uploads, media) go stale.
const LOCAL_ONLY = new Set(['/imagen', '/nanobanana', '/veo-start', '/veo-poll', '/tts', '/tts-multi', '/audio', '/video-slides', '/upload', '/fetch-url'])

async function proxyToNotebookService(req, res, next) {
  const NOTEBOOK_URL = process.env.NOTEBOOK_SERVICE_URL
  if (!NOTEBOOK_URL || notebookCB.isOpen || LOCAL_ONLY.has(req.path)) return next()

  // A Cloud Run 404 is a rollout routing gap, not a health failure: serve
  // locally without tripping the breaker.
  let fallBackToLocal = false
  try {
    await notebookCB.call(async () => {
      const isSSE = req.path !== '/tts' && req.path !== '/upload' && req.path !== '/fetch-url'

      // Required when the service is --no-allow-unauthenticated
      const idToken = await getCloudRunIdToken(NOTEBOOK_URL)

      const upstreamRes = await fetch(`${NOTEBOOK_URL}/api/notebook${req.path}`, {
        method:  req.method,
        headers: {
          'Content-Type':      'application/json',
          'x-correlation-id':  req.correlationId || '',
          'x-forwarded-by':    'fieldflow-monolith',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(120_000),
      })

      if (!upstreamRes.ok) {
        if (upstreamRes.status === 404) { fallBackToLocal = true; return }
        if (isSSE) {
          // Surface upstream errors as an SSE error event so the client can show them
          setupSSE(res)
          sendSSE(res, { error: `Upstream ${upstreamRes.status}: ${await upstreamRes.text().catch(() => 'error')}` })
          res.end()
        } else {
          const err = await upstreamRes.json().catch(() => ({ error: 'Upstream error' }))
          res.status(upstreamRes.status).json(err)
        }
        return
      }

      if (isSSE) {
        setupSSE(res)
        const reader = upstreamRes.body.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(decoder.decode(value, { stream: true }))
        }
        res.end()
      } else {
        const data = await upstreamRes.json()
        res.json(data)
      }
    })
    // Headers not sent yet, so the local handler can take over.
    if (fallBackToLocal) return next()
  } catch (e) {
    console.warn(`[notebook-proxy] falling back to local: ${e.message}`)
    // Failed mid-stream: the local handler would throw ERR_HTTP_HEADERS_SENT,
    // so close the open stream with an SSE error instead.
    if (res.headersSent) {
      try { sendSSE(res, { error: 'Upstream notebook service failed mid-stream' }) } catch { /* stream already torn down */ }
      try { res.end() } catch { /* noop */ }
      return
    }
    next()
  }
}

router.use('/notebook', proxyToNotebookService)

// ── Source capping helper ─────────────────────────────────────────────────────
// Caps token spend on large PDFs / pasted text; each route passes its own budget.
function capSources(sources, { maxPerSource = 20_000, maxSources = 4 } = {}) {
  return (sources || [])
    .slice(0, maxSources)
    .map(s => `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, maxPerSource)}\n---`)
    .join('\n\n')
}

// ── POST /api/notebook/upload ─────────────────────────────────────────────────
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024   // 20 MB decoded limit

router.post('/notebook/upload', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    const { name, type, dataBase64 } = req.body || {}
    if (!dataBase64) { res.json({ error: 'dataBase64 is required' }); return }
      // Check decoded size before allocating the buffer
    const decodedSize = Math.floor((dataBase64.length * 3) / 4)
    if (decodedSize > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` }); return
    }
    const buf = Buffer.from(dataBase64, 'base64')

    if (type === 'txt') {
      const content = buf.toString('utf-8').replace(/\u0000/g, '').slice(0, 200_000)
      res.json({ id: Math.random().toString(36).slice(2), name, type: 'txt', content, charCount: content.length })
    } else {
      // Same extractor as Document Vault (lib/extractDocumentText.js).
      const text = await extractText(buf, null, name)
      if (!text) { res.json({ error: `Unsupported or unreadable file: ${name}` }); return }
      const content = text.slice(0, 200_000)
      res.json({ id: Math.random().toString(36).slice(2), name, type, content, charCount: content.length })
    }
  } catch (e) {
    res.json({ error: e instanceof Error ? e.message : 'Upload failed' })
  }
})

// ── SSRF guard for fetch-url ──────────────────────────────────────────────────
// Every hop is resolved and checked, so a public name pointing at an internal
// IP or a 30x to one is refused. Returns null when a hop isn't public.
async function fetchPublicUrl(url, opts) {
  let current = url
  for (let hop = 0; hop <= 3; hop++) {
    if (await checkPublicUrl(current)) return null
    const r = await fetch(current, { ...opts, redirect: 'manual' })
    if (r.status < 300 || r.status >= 400) return r
    const loc = r.headers.get('location')
    if (!loc) return null
    current = new URL(loc, current).toString()
  }
  return null
}

// ── POST /api/notebook/fetch-url ──────────────────────────────────────────────
router.post('/notebook/fetch-url', async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    const { url } = req.body || {}
    if (!url) { res.json({ error: 'url is required' }); return }
    const pageRes = await fetchPublicUrl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NotebookBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!pageRes) { res.status(403).json({ error: 'URL not permitted' }); return }
    if (!pageRes.ok) { res.json({ error: `HTTP ${pageRes.status}` }); return }
    const html = await pageRes.text()
    const hostname = new URL(url).hostname

    // Readability strips nav/ads/banners; pages it can't parse as an article
    // fall back to plain tag-stripping below.
    const article = extractArticle(html, url)
    const text = (article?.text || html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')
      .trim()
    ).slice(0, 100_000)
    res.json({ id: Math.random().toString(36).slice(2), name: article?.title || hostname, type: 'url', content: text, charCount: text.length })
  } catch (e) {
    res.json({ error: e instanceof Error ? e.message : 'Fetch failed' })
  }
})

// ── POST /api/notebook/chat (SSE) ─────────────────────────────────────────────
router.post('/notebook/chat', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, message, history } = req.body || {}
    // Numbered so [1]/[2] citations map back to array indexes (ChatPanel.tsx chips).
    const srcBlock = (sources || []).slice(0, 4)
      .map((s, i) => `[${i + 1}] ${s.name}\n${String(s.content || '').slice(0, 15_000)}\n---`)
      .join('\n\n')
    // Cap each history message at 600 chars
    const histBlock = (history || []).slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text || '').slice(0, 600)}`)
      .join('\n')
    const prompt = `Sources:\n${srcBlock}\n\n${histBlock ? `Conversation so far:\n${histBlock}\n\n` : ''}User: ${message}`
    const [chatSysBase, orgCtx, sector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'notebook_chat_system',
        `You are a knowledgeable, warm research companion helping the user explore their sources.

How to respond:
- Draw answers primarily from the provided sources; cite with a bracketed number matching the source's position above — [1] for the first source, [2] for the second, etc. — placed right after the sentence or claim it supports. Cite every fact, quote, or figure you pull from a source. Never invent a citation number that doesn't correspond to a listed source.
- Write in a conversational, human tone — like a thoughtful colleague, not a search engine.
- For simple questions use flowing prose; for complex ones use brief structure (short bullets or a header).
- If the answer isn't clearly in the sources, say so honestly, then share your best understanding and label it as such.
- Occasionally ask a genuinely curious follow-up question to deepen the conversation — but only when it feels natural.
- Celebrate good questions. Be encouraging, intellectually engaged, and never robotic.`),
      buildOrgContext(req.user?.orgId),
      getOrgSector(req.user?.orgId),
    ])
    const overlay = sectorOverlay(sector, 'notebook_chat_system')
    const chatSys = [chatSysBase, orgCtx, overlay].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'notebook_chat',  model: 'flash', inputLength: prompt.length + chatSys.length,  maxOutputTokens: 2048 })
    await callGeminiNotebook(apiKey, prompt, chatSys, res, 2048, 0.6, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── Documentary form for Video Overview ─────────────────────────────────────
// Video Overview is a short grounded documentary. Directives go in the request
// prompt, not the system instruction, so an org prompt override can't drop the
// grounding rules. Tone ids mirror VIDEO_TONES in src/components/notebook/voices.ts;
// a tone changes form and delivery, never the grounding rules.
// Every tone is ONE narrator (Better India / YourStory style), and each line doubles
// as an on-screen caption.
const VIDEO_TONES = {
  storytelling: {
    adj: 'warm, human, story-led',
    form: 'a short human-story film in the style of The Better India: one place, the problem it faced, and the people who changed it (by role, never by name)',
    narrator: 'warm, sincere and close — a storyteller, not a presenter; the facts carry the feeling',
    opening: 'Hook (1 line, under 12 words): the place and what was wrong there — or what changed — in one plain, striking sentence (e.g. "In Supaul, the village ponds had stood empty for years.").',
    close: 'Land on the most human real detail or a verbatim quote from the sources, then one short closing line on what it means for the place — never a slogan.',
    pace: 'short spoken sentences (mostly 6-14 words), one idea per sentence, one vivid REAL detail per beat (only details the sources give). Never add weather, light, sounds or mood the sources don\'t state — not even "a warm morning".',
    cues: '[warmly], [gently], [hopeful], [quietly], [reflective], [matter-of-fact], [grave] for the hard parts',
  },
  energetic: {
    adj: 'upbeat, curious, information-packed',
    form: 'a short, upbeat explainer story in the style of YourStory: one clear idea about real field work, explained fast, with the numbers that prove it',
    narrator: 'lively, curious and confident — talking straight to the viewer',
    opening: 'Hook (1 line): the single most striking real fact in the sources — or ONE short question that the very next line answers with a fact from the sources.',
    close: 'Close on the clearest number or the next step the sources state, landing the one takeaway in a single punchy line — not a slogan.',
    pace: 'short, punchy sentences (mostly under 12 words); a concrete number, place or date in nearly every line; keep building momentum. The energy comes from pace, specifics and clear stakes — never from hype.',
    cues: '[energetic], [upbeat], [curious], [confident], [punchy], [emphatic], [measured] for the challenges',
  },
  documentary: {
    adj: 'calm, grounded',
    form: 'a short grounded documentary about real field work',
    narrator: 'measured and clear — carries the story, sets context and makes the transitions',
    opening: 'Cold open (1-2 lines): one real, specific moment from the sources — a place, a date, what was actually done there.',
    close: 'Close on a real detail or quoted line from the sources, not a slogan.',
    pace: 'calm, specific, unhurried; let each fact land before moving on.',
    cues: '[measured], [reflective], [matter-of-fact], [quietly], [warmly], [grave], [curious]',
  },
  news: {
    adj: 'crisp, factual news-report',
    form: 'a short TV-style NEWS REPORT about real field work — like a bulletin package, neutral and authoritative',
    narrator: 'a crisp, neutral, authoritative reporter',
    opening: 'Headline (1 line): the single most newsworthy fact — what, where, when — then the key figure.',
    close: 'Sign off with the bottom line and the most important number or what happens next, as the sources state it.',
    pace: 'inverted pyramid — most important facts first, then detail, then background; brisk, clear sentences; neutral third person; attribute every fact ("according to the July field reports…"); no opinion, praise or intensifiers ("significantly", "dramatically", "major") unless the sources measure the change.',
    cues: '[crisp], [authoritative], [matter-of-fact], [neutral], [serious], [brisk]',
  },
  inspiring: {
    adj: 'uplifting, purpose-driven',
    form: 'a short, uplifting film about real field work for supporters, partners and donors',
    narrator: 'warm, confident and uplifting — makes the case for why this work matters',
    opening: 'Hook (1 line): the most inspiring REAL achievement in the sources — a number or a change that shows what is possible.',
    close: 'Close with what comes next (only as the sources state it) and one clear, honest call to action — e.g. to support, follow or share the work — without slogans or exaggeration.',
    pace: 'confident and uplifting, building towards the close; let achievements land with their real numbers — inspiration comes from real results, never from exaggeration.',
    cues: '[inspiring], [warmly], [confident], [hopeful], [upbeat], [emphatic], [measured] for the challenges',
  },
}
const videoTone = (id) => VIDEO_TONES[id] || VIDEO_TONES.storytelling

function documentaryNarration(toneId, narratorGender) {
  const t = videoTone(toneId)
  return `STORY FILM — this is the voice-over of ${t.form}.
ONE narrator speaks every line: ${t.narrator}. The narrator's voice is a ${narratorGender === 'F' ? 'woman' : 'man'}'s — if a line ever refers to the narrator, keep its grammar consistent with that, but narrate in the third person. There is no second voice, no host, no interviewer and no conversation: never write a question-and-answer exchange, never address a co-host, never "we" for the narrator and a partner.
Write it the way story films on channels like The Better India and YourStory are written: to be HEARD, in short beats, one idea per sentence. Each line is one beat of the story — 1-2 sentences, about 8-20 words. The video shows each line as big on-screen captions over the pictures, so it must read well on screen too: plain words, no lists, no brackets, no abbreviations a viewer can't say aloud.
The story, in this order (never announce the parts):
1. ${t.opening}
2. The place and the problem: where this is, who it affects (by role and place), and what was wrong — only as the sources state it. Make the stakes concrete with a real number or fact.
3. The turning point: one line that turns the story from the problem to the work — what started it, when and who (by role or organisation).
4. The work: concrete facts — what was done, when, where and how many — in story order.
5. What changed: keep OUTPUTS (people reached, trained, groups formed, inputs distributed) separate from OUTCOMES (income, yield, behaviour change). Only call something an outcome or impact if the sources show a before/after or a measured change; otherwise say plainly that it isn't measured yet.
6. What's still hard: one honest line about a challenge, gap or open question the sources raise — or that the records don't show one.
7. ${t.close}
Grounding rules (these override any other instruction):
- Every place, date, number, name and quote must come from the sources. No invented scenery, weather, sounds, emotions, dialogue, or composite characters. Never say what someone felt or thought unless a source says so.
- Quotes: only verbatim text that appears in a source, introduced by the narrator with where it comes from (e.g. "As the Supaul field report of 14 July puts it, '…'"). Never put a paraphrase inside quotation marks.
- Privacy: refer to community members by role and place ("a woman fish farmer in Supaul"), never by personal name, even if the sources contain one. Staff and officials may be named if the sources name them.
- Attribute key facts to their source as you go ("the July field reports record…", "according to the MIS…").
- Say "about" or "roughly" for approximate figures; never round a number up into a bigger-sounding one.
- Where the sources are thin, say so — a documentary admits what it doesn't know.
Pace & voice: ${t.pace} In every tone: no exaggeration, no invented drama, no NGO slogans ("empowering communities", "transforming lives"), no rhetorical questions beyond a hook your tone allows, no "welcome", "hi everyone", "thanks for watching", "like and subscribe".
Delivery cues: ${t.cues} — never [laughs].`
}

/** Target script length: 9:16 Reels get a tight cut (≤3 min, best ~90s), 16:9
 *  the 2-3 minute story-film length. Custom instructions can override. */
function videoLength(videoFormat) {
  return videoFormat === 'reel'
    ? { label: '45-75-second', lines: 'about 9-13 lines, 130-190 words in total' }
    : { label: '~2.5-minute', lines: 'about 20-28 lines, 320-420 words in total' }
}

/** Shot pace per format — mirrors SHOT_PACE in src/components/notebook/videoShots.ts. */
function shotPace(videoFormat) {
  return videoFormat === 'reel'
    ? { rhythm: 'a new picture every 2-4 seconds of narration (about every 6-11 spoken words) — Reels cut fast', maxWords: 14 }
    : { rhythm: 'a new picture every 4-7 seconds of narration (about every 10-18 spoken words)', maxWords: 22 }
}

function documentarySegments(photos, languageLabel = 'English', videoFormat = 'landscape') {
  const list = Array.isArray(photos) && photos.length
    ? photos.slice(0, 24).map(p => `${p.id}: ${String(p.caption || '(no caption)').slice(0, 160)}${p.place || p.date ? ` [${[p.place, p.date].filter(Boolean).join(', ')}]` : ''}`).join('\n')
    : '(none — omit "photo" on every shot)'
  const pace = shotPace(videoFormat)
  return `ON-SCREEN LANGUAGE: every piece of text that appears on screen — title, bullets, stat value/label, quote, quoteAttribution, chapter, location, date, source and headline — must be written in ${languageLabel}, the same language as the narration, in its own script (place names as they are normally written in ${languageLabel}). The ONLY exception is each shot's "scene", which is always in English because it drives the image generator. Never copy the [n] or [n.s] markers into any on-screen text.
Titles are the POINT being made, as a short plain statement in ${languageLabel} stated only as strongly as the sources and narration support (e.g. "Training moved to the village ponds", or "<number from the sources> farmers now use drip lines"), not a topic label ("Training"). On a "stat" card the big number is already on screen, so its title says what the number means without repeating it (stat "38", label "ponds desilted, Apr–Jun 2026" → title "Water came first"). Bullets are short and concrete — each one should match something the narration actually says in that segment, in the order it is said.
Quotes: the quote must be verbatim from the sources. If the sources are in a different language from ${languageLabel}, give a faithful translation instead and add the word for "translated" (in ${languageLabel}) in brackets at the end of quoteAttribution.
PICTURES — plan the edit like a documentary video editor: the picture changes whenever the narration moves on to a new concrete subject, so the viewer SEES each thing as it is said instead of one picture sitting under several different points. Required on EVERY segment:
- shots: the pictures shown under that card, in order, each {"at": "<n.s>", "scene": "...", "photo": <id, optional>}.
  - "at" is the sentence marker where this picture starts: n = line index, s = sentence within that line (lines with several sentences carry [n.s] markers; a line without them is one sentence, so use "n.0"). The first shot of a segment starts at "<fromLine>.0", and every "at" lies inside that segment's own lines.
  - One shot per new subject — roughly one per sentence, ${pace.rhythm}. Never hold one picture for more than about ${pace.maxWords} spoken words; merge only very short sentences about the same thing.
  - scene: one concrete English sentence (max 30 words) describing exactly what this picture shows — the real setting, activity and objects that THIS part of the narration is talking about, as the narration and sources describe them (e.g. "close-up of hands releasing silver fingerlings from a plastic bag into a muddy village pond"). Specific to this moment, never a generic stock scene; people only by role, small or seen from behind; no text, numbers, charts, logos or identifiable faces.
  - Think of it as the B-roll shot list of a documentary story film (the kind of footage The Better India's films cut to): consecutive shots must look clearly different. Vary the framing the way an editor would: an establishing wide shot for a place, a medium shot for an activity, a close-up detail for an object, tool or record (nets, feed sacks, a register, a water-test kit). For a "stat" card, show the thing the number counts, never a chart.
  - photo: the id of a REAL field photo from the list below, ONLY if its caption shows exactly what this shot is about. Use each photo at most twice in the whole video, never in two shots in a row.
Required on the FIRST segment only:
- headline: the film's single clear message — one plain sentence (max 16 words) in ${languageLabel}, stated only as strongly as the sources support.
This is a DOCUMENTARY. For each segment also include these fields whenever the sources support them (omit a field rather than guess):
- chapter: ONLY on the first segment of each act (cold open, context, the work, what changed, what's still hard, close) — a short factual act title of at most 4 words, e.g. "The dry months". Omit on every other segment. Aim for 4-6 chapters in total.
- location: the real place being discussed (village/block/district, state) exactly as the sources name it.
- date: the real date or period being discussed (e.g. "14 Jul 2026", "Jul–Sep 2026") exactly as the sources support it.
- source: a short name for the kind of record these facts come from (e.g. "Daily field reports, Kosi", "MIS indicators") — never a person's name.
Quotes must be verbatim from the sources. quoteAttribution says where the quote comes from — the kind of record or speaker's role, plus the place and date ONLY as far as the source states them (omit any part it doesn't give; never invent a place or date). Never a private person's name.
Privacy: no on-screen field (title, bullets, stat, quote, quoteAttribution, chapter, location, source, headline) may contain a community member's personal name — refer to people by role and place. For a beneficiary-profile source, use "Beneficiary profile" (in the on-screen language) as the source, never the person's name.
Available real field photos (id: caption [place, date]):
${list}`
}

// ── POST /api/notebook/audio (SSE) ───────────────────────────────────────────
router.post('/notebook/audio', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, languageCode = 'en-IN', languageLabel = 'English (India)', host1Name = 'Alex', host2Name = 'Jordan', customPrompt = '', mediaType = 'audio', videoFormat = 'landscape', videoTone: toneId = 'storytelling', narratorGender = 'M' } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 25_000, maxSources: 3 })
    const langInstruction = languageCode === 'en-IN'
      ? 'Write the entire script in Indian English.'
      : `Write the entire script in ${languageLabel} (language code: ${languageCode}). Use the natural spoken form of the language.`
    // Video shares this route with the podcast but is one narrator, not two hosts;
    // same "ALEX: [tone] text" line format so the client handles both alike.
    const isVideo = mediaType === 'video'
    if (isVideo) {
      const t = videoTone(toneId), length = videoLength(videoFormat)
      const framing = 'This is the voice-over of a produced story VIDEO with its own pictures and on-screen captions — ONE narrator, no second voice, no host, no conversation. Never call it a "podcast", a "show" or an "episode", and never use podcast or YouTube-host phrases ("welcome", "hi everyone", "thanks for watching", "like and subscribe").'
      // Custom instructions go first and are restated after the sources;
      // a single trailing line gets ignored.
      const customBlock = customPrompt
        ? `TOP PRIORITY — the user's specific instructions for this video (follow these over the general guidance below, except never break the "ALEX:" line format or invent facts not in the sources):\n"${customPrompt}"\n\n`
        : ''
      const customReminder = customPrompt ? `\n\nReminder — follow the user's top-priority instructions: "${customPrompt}"` : ''
      const prompt = `${customBlock}Based on these sources, write the single-narrator voice-over for a ${length.label} ${t.adj} story film (${length.lines}). Format EVERY line as "ALEX: [tone] text" — "ALEX: " is only a parsing marker (never spoken) and every line is the same narrator; "[tone]" is a one-or-two-word delivery cue (e.g. ${t.cues}) picked to fit that line, varied naturally — never forced onto plainly neutral lines. Dig into SPECIFIC facts, figures, places, dates and findings from the sources — not generic commentary. Start immediately with the first line. ${framing} ${langInstruction}\n\n${documentaryNarration(toneId, narratorGender)}\n\nSources:\n${srcBlock}${customReminder}`
      // Video has its own system prompt id; format and single-voice rules are
      // appended after it so no saved prompt can undo them.
      const [videoSysBase, videoSector] = await Promise.all([
        getOrgPrompt(req.user?.orgId, 'notebook_video_system',
          `You write the voice-over for short documentary story films, like the human stories on The Better India and the explainers on YourStory. One narrator speaks every line — never a dialogue. Every line MUST start with "ALEX: [tone] ", where [tone] is a short delivery cue in square brackets chosen to fit that line and varied naturally. No stage directions beyond the cue, no other formatting, no emoji. Write exclusively in ${languageLabel}.
Ground every claim in the provided sources — concrete numbers, places, dates and verbatim quotes rather than vague paraphrase. If the sources don't cover something, say so instead of inventing it. Short spoken sentences, one idea each, with a specific detail in nearly every line.`),
        getOrgSector(req.user?.orgId),
      ])
      const videoSys = [
        videoSysBase,
        sectorOverlay(videoSector, 'notebook_video_system'),
        `${framing} Every line is "ALEX: [tone] text" — the one narrator.`,
        customPrompt ? 'The user has given specific instructions for this video; they take priority over the default style, structure and focus described here (but never over the line format, the single narrator or the rule against inventing facts).' : '',
      ].filter(Boolean).join('\n\n')
      trackUsage(req.user?.orgId, { service: 'notebook_audio', model: 'flash', inputLength: prompt.length + videoSys.length, maxOutputTokens: 8192 })
      await callGeminiNotebook(apiKey, prompt, videoSys, res, 8192, 0.75, null, null, signal)
      return
    }
    // ── Podcast (Audio Overview): two hosts in conversation ──
    // Custom instructions first and restated after the sources (see video branch).
    const customBlock = customPrompt
      ? `TOP PRIORITY — the user's specific instructions for this podcast (follow these over the general guidance below, except never break the "ALEX:"/"JORDAN:" line format or invent facts not in the sources):\n"${customPrompt}"\n\n`
      : ''
    const customReminder = customPrompt ? `\n\nReminder — follow the user's top-priority instructions: "${customPrompt}"` : ''
    // ALEX is always voiced male and JORDAN female (the UI enforces it). Saying so
    // stops non-English scripts putting the female host's lines under ALEX.
    const prompt = `${customBlock}Based on these sources, create a ~5-minute engaging podcast script between two hosts: Host 1 is "${host1Name}", a MALE speaker (man's voice), thoughtful, asks probing questions; Host 2 is "${host2Name}", a FEMALE speaker (woman's voice), knowledgeable, gives clear explanations. Every "ALEX:" line is spoken by the man ${host1Name}; every "JORDAN:" line by the woman ${host2Name} — never swap them, and keep each name's gender consistent throughout. Inside the dialogue, the hosts address each other by their names "${host1Name}" and "${host2Name}". Format every line as "ALEX: [tone] dialogue text" for ${host1Name} and "JORDAN: [tone] dialogue text" for ${host2Name} — "ALEX: "/"JORDAN: " are parsing markers, not names spoken aloud, and "[tone]" is a short one-or-two-word delivery cue (e.g. [curious], [warmly], [surprised], [thoughtful], [concerned], [excited], [matter-of-fact], [laughs]) picked to fit what's being said in that line. Vary the tone naturally across the script — real conversations aren't delivered flat — but never force emotion onto lines that are plainly neutral. Dig into SPECIFIC facts, figures, names, and findings from the sources — not generic commentary. Start immediately with the script. ${langInstruction}\n\nSources:\n${srcBlock}${customReminder}`
    const [audioSysBase, audioSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'notebook_audio_system',
        `You are a podcast script writer. Create natural, engaging dialogue. ALEX is the MALE speaker ${host1Name} (man's voice); JORDAN is the FEMALE speaker ${host2Name} (woman's voice) — keep this gender/name pairing consistent and never voice a woman's line under ALEX or a man's under JORDAN. Every line MUST start with "ALEX: [tone] " or "JORDAN: [tone] ", where [tone] is a short delivery/emotion cue in square brackets (e.g. [curious], [warmly], [excited], [thoughtful]) chosen to fit that line and varied naturally across the script — not the same cue repeated every line. The two hosts call each other by their names within the dialogue. No stage directions beyond the bracketed tone cue, no other formatting, no emoji. Write exclusively in ${languageLabel}.
Ground every claim in the provided sources — reference concrete numbers, names, events, and quotes rather than vague paraphrasing. If the sources don't cover something, have the hosts say so instead of inventing it. Write short back-and-forth exchanges, not monologues, with a specific detail (a stat, date, or quote) in nearly every turn.`),
      getOrgSector(req.user?.orgId),
    ])
    const audioSys = [
      audioSysBase,
      sectorOverlay(audioSector, 'notebook_audio_system'),
      customPrompt ? 'The user has given specific instructions for this podcast; they take priority over the default style, structure and focus described here (but never over the line format or the rule against inventing facts).' : '',
    ].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'notebook_audio', model: 'flash', inputLength: prompt.length + audioSys.length, maxOutputTokens: 8192 })
    await callGeminiNotebook(apiKey, prompt, audioSys, res, 8192, 0.75, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/video-slides (SSE) ───────────────────────────────────
// Slide segments (title/bullets/stat/quote) synced to ranges of the /audio
// script's lines — the visuals behind the Video Overview narration.
router.post('/notebook/video-slides', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, scriptText, lineCount, photos, languageLabel = 'English', customPrompt = '', videoFormat = 'landscape' } = req.body || {}
    if (!scriptText || !lineCount) { sendSSE(res, { error: 'scriptText and lineCount are required' }); res.end(); return }
    const srcBlock = capSources(sources, { maxPerSource: 15_000, maxSources: 3 })
    // Same custom instructions as the narration, so the cards follow them too.
    const customBlock = customPrompt
      ? `TOP PRIORITY — the user's specific instructions for this video (follow these when choosing titles, emphasis and visuals, except never break the JSON format, the line-range rules, or invent facts):\n"${customPrompt}"\n\n`
      : ''
    const prompt = `${customBlock}Here is a ${lineCount}-line narration script (the voice-over of a short story film) and the original sources it's based on. Each line is prefixed with its 0-based index in square brackets, e.g. "[3]" — fromLine/toLine must use those indices; a line with several sentences also marks each sentence, e.g. "[3.1]" — the shots' "at" uses those. Break the narration into short sequential visual "slide" segments that appear on screen beside the pictures while the narration plays, for a short grounded documentary — clean informational cards, with a planned sequence of pictures under each.

Start a NEW segment every 2-3 lines (never more than 4) so the on-screen card changes in step with what's actually being said — a segment spanning 10+ lines reads as a static slideshow, not a synced video. For a ${lineCount}-line script that means roughly ${Math.max(6, Math.ceil(lineCount / 3))} segments. (The pictures change faster than the cards — see PICTURES below.)

Each segment must cover a contiguous range of line indices (0 to ${lineCount - 1}), covering ALL lines with no gaps or overlaps, ordered by fromLine ascending.

For each segment, provide:
- fromLine, toLine: the first and last line index it covers
- title: the point of those lines as a short statement (<=7 words) — see the title rules below
- visual: one of "list" (2-3 short bullets), "stat" (one specific figure from the sources with a label), or "quote" (a short verbatim quote from the sources)
- bullets: array of 2-3 short (<=10 word) bullets grounded in the sources, each echoing a point the narration makes in these lines, in the order it is said — only when visual is "list"
- stat: {"value": "...", "label": "..."} — a specific figure actually present in the sources — only when visual is "stat"
- quote: a short verbatim quote from the sources, plus quoteAttribution (see the quote rules below) — only when visual is "quote"
- shots: the planned pictures under the card (see PICTURES below)

Never invent a stat or quote that isn't actually in the sources — use "list" instead if nothing suitable exists for that segment.

Make the cards INFORMATION-DENSE and punchy — the viewer should learn a fact from every card: prefer a "stat" card whenever the lines mention a figure that is in the sources (aim for at least a third of segments as stat cards when the sources have enough numbers), and make bullets carry a concrete number, place or date wherever the sources give one rather than general statements. Titles are short, active statements of the point.

${documentarySegments(photos, languageLabel, videoFormat)}

Return ONLY a valid JSON array of segment objects, no markdown fences, no explanation.

Narration script:
${scriptText}

Sources:
${srcBlock}`
    const videoSlidesSys = await getOrgPrompt(req.user?.orgId, 'notebook_video_slides_system',
      'You are producing synced visual slide data for a video overview. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON array. Never use literal newline characters inside JSON string values. Never use emoji in any title, bullet, stat, label, or quote — this is a professional briefing, not a social post.')
    // A segment every 2-3 lines plus a shot per sentence needs room: a truncated
    // JSON array drops every segment. 24k fits a ~40-line script; JSON mode stops
    // stray quotes/fences breaking the parse.
    trackUsage(req.user?.orgId, { service: 'notebook_video_slides', model: 'flash', inputLength: prompt.length + videoSlidesSys.length, maxOutputTokens: 24_576 })
    await callGeminiNotebook(apiKey, prompt, videoSlidesSys, res, 24_576, 0.5, 'application/json', null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/tts ───────────────────────────────────────────────────
// Single voice (Video Overview voices each line separately for word-level sync).
// Body: { text, voice, style? }  →  { audioData (base64 PCM), mimeType, model }
// Local-only (never proxied) so lib/tts.js is the one TTS implementation.
router.post('/notebook/tts', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  try {
    const { text, voice = 'Charon', style = '' } = req.body || {}
    if (!text) { res.status(400).json({ error: 'text is required' }); return }
    trackUsage(req.user?.orgId, { service: 'notebook_tts', model: 'tts', ttsChars: String(text).length })
    res.json(await synthesizeSpeech(apiKey, {
      segments: [{ text: String(text), style: String(style || '') }],
      voices: String(voice),
      signal: makeAbortSignal(req),
    }))
  } catch (e) {
    console.error('[notebook]', e)
    res.status(500).json({ error: 'TTS failed' })
  }
})

// ── POST /api/notebook/tts-multi ─────────────────────────────────────────────
// Two-person conversation in ONE call (natural turn-taking). Each turn names
// its speaker explicitly, so voices can't swap between hosts.
// Body: { turns: [{ speaker, text, style? }], speakers: [{ speaker, voice }] }
router.post('/notebook/tts-multi', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  try {
    const { turns, speakers } = req.body || {}
    if (!Array.isArray(turns) || !turns.length || !Array.isArray(speakers) || !speakers.length) {
      res.status(400).json({ error: 'turns and speakers are required' }); return
    }
    const voices = Object.fromEntries(speakers.slice(0, 2).map(s => [String(s.speaker), String(s.voice || 'Charon')]))
    const segments = turns.map(t => ({ text: String(t.text || ''), speaker: String(t.speaker), style: String(t.style || '') }))
    if (segments.some(s => !(s.speaker in voices))) {
      res.status(400).json({ error: 'every turn.speaker must be listed in speakers' }); return
    }
    trackUsage(req.user?.orgId, { service: 'notebook_tts', model: 'tts', ttsChars: segments.reduce((n, s) => n + s.text.length, 0) })
    res.json(await synthesizeSpeech(apiKey, { segments, voices, signal: makeAbortSignal(req) }))
  } catch (e) {
    console.error('[notebook]', e)
    res.status(500).json({ error: 'Multi-speaker TTS failed' })
  }
})

// ── POST /api/notebook/study-guide (SSE) ────────────────────────────────────
router.post('/notebook/study-guide', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, format, customPrompt = '' } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 20_000, maxSources: 4 })
    const formatPrompts = {
      summary:  'Write a comprehensive executive summary with key themes, main findings, and important conclusions. Use ## headings and bullet points. Pull out specific numbers, names, dates, and quotes from the sources rather than generic statements.',
      faq:      'Generate the top 10 most important questions and detailed answers about the content, each grounded in specific facts from the sources (with figures/quotes where available). Format as ## Q: ... then **A:** ...',
      timeline: 'Extract and list all chronological events, developments, or steps mentioned. Format as a numbered timeline with dates/phases where available, each entry citing the specific detail it came from.',
      briefing: 'Write a concise one-page briefing document with: Context, Key Points (bullets), Implications, and Recommended Actions — each section grounded in concrete details (figures, names, quotes) from the sources, not generic filler.',
    }
    const prompt = `${formatPrompts[format] || formatPrompts.summary}${customPrompt ? `\n\nAdditional instructions: ${customPrompt}` : ''}\n\nSources:\n${srcBlock}`
    const [studySysBase, studySector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'notebook_study_system',
        'You are a research analyst. Create clear, well-structured study materials in Markdown. Be thorough and specific — ground every claim in the provided sources, citing the source name in parentheses (e.g. (Source: name)) whenever you state a specific fact, figure, or quote. Never invent information not present in the sources; if the sources are thin on a point, say so explicitly rather than filling in generic content.'),
      getOrgSector(req.user?.orgId),
    ])
    const studySys = [studySysBase, sectorOverlay(studySector, 'notebook_study_system')].filter(Boolean).join('\n\n')
    // Dense full-dataset sources get cut off mid-section at 8192; Gemini 2.5 Pro
    // allows ~65k output, 24576 gives headroom without ballooning cost.
    const STUDY_GUIDE_MAX_TOKENS = 24_576
    trackUsage(req.user?.orgId, { service: 'notebook_study', model: 'flash', inputLength: prompt.length + studySys.length, maxOutputTokens: STUDY_GUIDE_MAX_TOKENS })
    await callGeminiNotebook(apiKey, prompt, studySys, res, STUDY_GUIDE_MAX_TOKENS, 0.55, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/slide-deck (SSE) ──────────────────────────────────────
router.post('/notebook/slide-deck', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, mode = 'detailed', customPrompt = '', fieldPhotoCaptions = [] } = req.body || {}
    // 10 slides don't need a 200KB context
    const srcBlock = capSources(sources, { maxPerSource: 18_000, maxSources: 3 })
    const modeInstructions = mode === 'presenter'
      ? 'Each slide: 3-4 concise bullet points (max 12 words each), 1-sentence speaker note. Minimal text, visual-first.'
      : 'Each slide: 5-6 detailed bullet points, comprehensive 2-3 sentence speaker notes with supporting detail.'
    // Photo captions rarely share wording with paraphrased bullets, so let the
    // model pick which caption a slide is about instead of keyword matching.
    const photoMatchInstruction = fieldPhotoCaptions.length > 0
      ? `\n\nHere are captions of real field photos available (each is a verbatim field report description):\n${fieldPhotoCaptions.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nFor each slide, if — and only if — one of these captions describes the SAME specific event/activity as that slide, add a "matchedCaption" field to that slide's JSON containing that caption copied EXACTLY as given above (verbatim, no edits). Leave "matchedCaption" out entirely for any slide with no genuinely matching caption — do not force a loose or generic match.`
      : ''
    // Custom instructions go first as top priority; they override defaults
    // except the JSON-shape/grounding rules.
    const customBlock = customPrompt
      ? `TOP PRIORITY — the user's specific instructions for this deck (follow these over the general guidance below, except never break the JSON format or invent facts):\n"${customPrompt}"\n\n`
      : ''
    const prompt = `${customBlock}Create a 10-slide presentation from these sources. Return ONLY a valid JSON array (no markdown, no explanation) with exactly this structure:
[
  {
    "title": "Slide title",
    "bullets": ["Point 1", "Point 2", "Point 3"],
    "speakerNotes": "What the presenter should say"
  }
]

Mode: ${mode === 'presenter' ? 'Presenter Slides' : 'Detailed Deck'}. ${modeInstructions}
Hard rules for a professional, clean deck:
- Titles: max 8 words, specific (name the actual topic, not "Overview" or "Key Points").
- Bullets: MAXIMUM 6 per slide, each ONE line (max ~14 words) — never a paragraph; split a long idea across bullets or move detail into speakerNotes. Overlong bullets overflow the slide and look unprofessional.
- Lead each bullet with the concrete fact/figure/name, not a generic verb.
Every bullet and speaker note must state a SPECIFIC fact, figure, name, or finding drawn from the sources — never generic filler like "various improvements were made". If the sources don't have enough material for 10 substantive slides, make fewer slides rather than padding.
The first slide is a title/overview slide. The last slide is conclusions/next steps.${photoMatchInstruction}

Sources:\n${srcBlock}`
    const [slidesSysBase, slidesSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'notebook_slides_system',
        'You are a presentation designer producing a polished, data-grounded slide deck for a professional/donor audience. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON array. Never use literal newline characters inside JSON string values. Keep every bullet to a single short line (never a paragraph) and at most 6 bullets per slide so nothing overflows the slide. Every bullet must be traceable to something actually stated in the sources. When the user gives specific instructions, follow them. Never use emoji anywhere in the title, bullets, or speaker notes — write like a professional analyst, not a social post.'),
      getOrgSector(req.user?.orgId),
    ])
    const slidesSys = [slidesSysBase, sectorOverlay(slidesSector, 'notebook_slides_system')].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'notebook_slides', model: 'flash', inputLength: prompt.length + slidesSys.length, maxOutputTokens: 8192 })
    await callGeminiNotebook(apiKey, prompt, slidesSys, res, 8192, 0.55, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/slide-revise (SSE) ────────────────────────────────────
router.post('/notebook/slide-revise', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, slide, instruction, index, total } = req.body || {}
    const srcBlock = (sources || []).map(s => `[SOURCE: ${s.name}]\n${s.content.slice(0, 20000)}\n---`).join('\n\n')
    const prompt = `You are revising slide ${index + 1} of ${total} in a presentation.

Current slide:
Title: ${slide.title}
Bullets: ${(slide.bullets || []).join(' | ')}
Speaker Notes: ${slide.speakerNotes}

Revision instruction: "${instruction}"

Keep bullets grounded in specific facts/figures from the sources — no generic filler. Return ONLY a single valid JSON object (no array, no markdown fences):
{
  "title": "...",
  "bullets": ["...", "..."],
  "speakerNotes": "..."
}

Sources:\n${srcBlock}`
    const slideReviseSys = await getOrgPrompt(req.user?.orgId, 'notebook_slide_revise_system',
      'You are a presentation designer. Return ONLY a single valid JSON object — no array, no markdown fences, no explanation. Never use literal newline characters inside JSON string values. Never use emoji anywhere in the title, bullets, or speaker notes.')
    trackUsage(req.user?.orgId, { service: 'notebook_revise', model: 'flash', inputLength: prompt.length + slideReviseSys.length, maxOutputTokens: 2048 })
    await callGeminiNotebook(apiKey, prompt, slideReviseSys, res, 2048, 0.55, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/mindmap (SSE) ─────────────────────────────────────────
// Grounded topic tree for the Mind Map tab; stream-then-parse-JSON like /slide-deck.
router.post('/notebook/mindmap', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, customPrompt = '' } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 18_000, maxSources: 4 })
    const prompt = `Build a hierarchical mind map of the key topics in these sources, like NotebookLM's mind map feature.

Return ONLY a valid JSON object (no markdown fences, no explanation) with this shape:
{"label": "Central topic (2-5 words)", "children": [{"label": "Theme (2-6 words)", "children": [{"label": "Sub-point (2-8 words)", "children": []}]}]}

Rules:
- Root node: one short label naming the overall subject of the sources.
- 3-6 second-level theme nodes, each grounded in something actually discussed in the sources.
- Each theme may have 2-5 third-level sub-point nodes with more specific facts/names/figures from the sources.
- Sub-points are leaves — "children" must be [] at the deepest level.
- Every label must be traceable to the sources; never invent a topic that isn't discussed.
- Keep the whole tree to at most ~20 nodes total.
${customPrompt ? `\nAdditional instructions: ${customPrompt}` : ''}

Sources:
${srcBlock}`
    const [mindmapSysBase, mindmapSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'notebook_mindmap_system',
        'You are producing a mind map data structure. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON object. Never use literal newline characters inside JSON string values.'),
      getOrgSector(req.user?.orgId),
    ])
    const mindmapSys = [mindmapSysBase, sectorOverlay(mindmapSector, 'notebook_mindmap_system')].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'notebook_mindmap', model: 'flash', inputLength: prompt.length + mindmapSys.length, maxOutputTokens: 4096 })
    await callGeminiNotebook(apiKey, prompt, mindmapSys, res, 4096, 0.5, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/flashcards-quiz (SSE) ─────────────────────────────────
// Flashcards + multiple-choice quiz for the "Learn" tab; same convention as /mindmap.
router.post('/notebook/flashcards-quiz', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources, customPrompt = '' } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 18_000, maxSources: 4 })
    const prompt = `Build study material from these sources: a flashcard deck and a multiple-choice quiz, like a training/learning aid for staff studying this material.

Return ONLY a valid JSON object (no markdown fences, no explanation) with this shape:
{
  "flashcards": [{"front": "A specific question or term", "back": "The specific answer or definition"}],
  "quiz": [{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "Why that's correct, citing the source detail"}]
}

Rules:
- Exactly 12 flashcards and 8 quiz questions.
- Every flashcard and question must be grounded in a specific fact, figure, name, or finding actually stated in the sources — never generic filler.
- Each quiz question has exactly 4 options, all plausible, only one correct (correctIndex is 0-3).
- explanation is 1 short sentence grounding the correct answer in the sources.
${customPrompt ? `\nAdditional instructions: ${customPrompt}` : ''}

Sources:
${srcBlock}`
    const [fcSysBase, fcSector] = await Promise.all([
      getOrgPrompt(req.user?.orgId, 'notebook_flashcards_quiz_system',
        'You are producing a flashcard deck and quiz data structure for a training aid. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON object. Never use literal newline characters inside JSON string values. Every card and question must be traceable to something actually stated in the sources.'),
      getOrgSector(req.user?.orgId),
    ])
    const fcSys = [fcSysBase, sectorOverlay(fcSector, 'notebook_flashcards_quiz_system')].filter(Boolean).join('\n\n')
    trackUsage(req.user?.orgId, { service: 'notebook_flashcards_quiz', model: 'flash', inputLength: prompt.length + fcSys.length, maxOutputTokens: 4096 })
    await callGeminiNotebook(apiKey, prompt, fcSys, res, 4096, 0.6, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/guide (SSE) ───────────────────────────────────────────
// Grounded overview + starter questions shown in ChatPanel before the first message.
// Separate from /study-guide so changing one doesn't affect the other.
router.post('/notebook/guide', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  setupSSE(res)
  try {
    const signal = makeAbortSignal(req)
    const { sources } = req.body || {}
    const srcBlock = capSources(sources, { maxPerSource: 18_000, maxSources: 4 })
    const prompt = `Sources:\n${srcBlock}\n\nWrite a short landing overview for this notebook: one tight paragraph (2-4 sentences) summarizing what these sources cover, grounded in specific facts from them. Then on a new line write "## Suggested questions" followed by exactly 4 bullet points, each a specific question a reader could ask that these sources can actually answer (not generic ones). Format:\n\n<paragraph>\n\n## Suggested questions\n- Question 1\n- Question 2\n- Question 3\n- Question 4`
    const guideSys = await getOrgPrompt(req.user?.orgId, 'notebook_guide_system',
      'You are writing a short, specific landing summary for a research notebook. Ground every claim in the provided sources. Never invent information not present in the sources. Return plain text in exactly the requested format — no extra commentary.')
    trackUsage(req.user?.orgId, { service: 'notebook_guide', model: 'flash', inputLength: prompt.length + guideSys.length, maxOutputTokens: 1024 })
    await callGeminiNotebook(apiKey, prompt, guideSys, res, 1024, 0.5, null, null, signal)
  } catch (e) {
    sendSSE(res, { error: e instanceof Error ? e.message : 'Error' })
    res.end()
  }
})

// ── POST /api/notebook/imagen ────────────────────────────────────────────────
// Photorealistic image via Imagen 3 → { imageData (base64 PNG), mimeType }. Local-only.
router.post('/notebook/imagen', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  try {
    const { prompt, aspectRatio = '16:9' } = req.body || {}
    if (!prompt) { res.status(400).json({ error: 'prompt required' }); return }
    trackUsage(req.user?.orgId, { service: 'notebook_imagen', model: 'imagen', imageCount: 1 })

    // API key in a header, never the URL
    const imagenRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          instances:  [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio },
        }),
        signal: AbortSignal.timeout(45_000),
      }
    )
    const data = await imagenRes.json()
    if (!imagenRes.ok) {
      const msg = data?.error?.message || `Imagen error ${imagenRes.status}`
      res.status(imagenRes.status).json({ error: msg }); return
    }
    const pred = data?.predictions?.[0]
    if (!pred?.bytesBase64Encoded) {
      res.status(500).json({ error: 'No image returned from Imagen' }); return
    }
    res.json({ imageData: pred.bytesBase64Encoded, mimeType: pred.mimeType || 'image/png' })
  } catch (e) {
    console.error('[notebook]', e)
    res.status(500).json({ error: 'Imagen request failed' })
  }
})

// ── POST /api/notebook/nanobanana ────────────────────────────────────────────
// Image via Gemini 2.5 Flash Image for SlideDeck.tsx / VideoOverview.tsx photos
// → { imageData (base64), mimeType }. Local-only. Optional `referenceImage` chains
// each photo off the previous one for a consistent subject/style across a deck.
const NB_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
router.post('/notebook/nanobanana', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  try {
    // referenceMode 'style' (Video Overview): reference carries style only, the
    // subject is the described scene. Default keeps subject continuity for SlideDeck.
    const { prompt, referenceImage, referenceMode, aspectRatio } = req.body || {}
    if (!prompt) { res.status(400).json({ error: 'prompt required' }); return }
    // Requested frame shape (4:3 split-screen, 9:16 Reels) so the video needn't crop a square.
    const ratio = NB_ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : null
    trackUsage(req.user?.orgId, { service: 'notebook_nanobanana', model: 'nanobanana', imageCount: 1 })

    const requestParts = []
    if (referenceImage?.data) {
      requestParts.push({ inlineData: { mimeType: referenceImage.mimeType || 'image/png', data: referenceImage.data } })
      requestParts.push({ text: referenceMode === 'style'
        ? `Use the attached reference image ONLY for its drawing style, line quality and colour palette. Do NOT copy its subject, composition or scene. Draw a new picture of exactly this: ${prompt}`
        : `Using the attached reference image to match visual style, subject continuity, lighting, and tone: ${prompt}` })
    } else {
      requestParts.push({ text: prompt })
    }

    let useRatio = ratio
    const callNanoBanana = async (parts) => {
      const nbRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts }],
            // This model requires both modalities; 'IMAGE' alone fails.
            // The extractor below ignores any stray text part.
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(useRatio ? { imageConfig: { aspectRatio: useRatio } } : {}) },
          }),
          signal: AbortSignal.timeout(45_000),
        }
      )
      const data = await nbRes.json()
      // An API version without imageConfig rejects the call; a square beats no picture.
      if (nbRes.status === 400 && useRatio) { useRatio = null; return callNanoBanana(parts) }
      if (!nbRes.ok) return { status: nbRes.status, error: data?.error?.message || `Nano Banana error ${nbRes.status}` }
      const cand    = data?.candidates?.[0]
      const imgPart = (cand?.content?.parts || []).find(p => p.inlineData)
      if (imgPart) return { image: imgPart }
      // 200 with no image = safety block or text-only reply; keep the reason for the UI.
      const reason = data?.promptFeedback?.blockReason || cand?.finishReason || 'unknown'
      const said   = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join(' ').slice(0, 160)
      return { status: 500, error: `No image returned from Nano Banana (${reason})${said ? `: ${said}` : ''}` }
    }

    // Misses are intermittent: retry once text-only (the style reference often
    // triggers a text reply) with an explicit ask for an image.
    let result = await callNanoBanana(requestParts)
    if (!result.image && result.status === 500) {
      result = await callNanoBanana([{ text: `Generate an image (no text reply). ${prompt}` }])
    }
    if (!result.image) { res.status(result.status).json({ error: result.error }); return }
    res.json({ imageData: result.image.inlineData.data, mimeType: result.image.inlineData.mimeType || 'image/png' })
  } catch (e) {
    console.error('[notebook]', e)
    res.status(500).json({ error: 'Nano Banana request failed' })
  }
})

// ── POST /api/notebook/veo-start ─────────────────────────────────────────────
// Start a Veo 3.1 Fast image-to-video job from a still (VideoOverview.tsx key
// segments → 8s clips). Long-running: returns the operation name; the client polls
// /veo-poll. Local-only, since the download needs the server-side API key.
const VEO_MODEL = 'veo-3.1-fast-generate-preview'
router.post('/notebook/veo-start', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  try {
    const { imageData, mimeType = 'image/png', prompt = '', aspectRatio = '16:9' } = req.body || {}
    if (!imageData) { res.status(400).json({ error: 'imageData required' }); return }
    trackUsage(req.user?.orgId, { service: 'notebook_veo', model: 'veo', videoCount: 1 })

    const veoRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          instances: [{
            prompt: prompt || 'Subtle, natural, cinematic motion. Keep the scene and subject consistent with the image.',
            image: { inlineData: { mimeType, data: imageData } },
          }],
          parameters: { aspectRatio: aspectRatio === '9:16' ? '9:16' : '16:9', resolution: '720p', durationSeconds: '8' },
        }),
        signal: AbortSignal.timeout(45_000),
      }
    )
    const data = await veoRes.json()
    if (!veoRes.ok) {
      const msg = data?.error?.message || `Veo error ${veoRes.status}`
      res.status(veoRes.status).json({ error: msg }); return
    }
    if (!data?.name) { res.status(500).json({ error: 'Veo did not return an operation name' }); return }
    res.json({ operationName: data.name })
  } catch (e) {
    console.error('[notebook]', e)
    res.status(500).json({ error: 'Veo start failed' })
  }
})

// ── POST /api/notebook/veo-poll ──────────────────────────────────────────────
// Poll a Veo operation: { done:false } while running; when done, the MP4 is downloaded
// server-side (URL needs the API key) and returned as base64. { done:true, error } on failure.
router.post('/notebook/veo-poll', async (req, res) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
  if (!apiKey) { res.status(500).json({ error: 'GEMINI_API_KEY not set' }); return }
  try {
    const { operationName } = req.body || {}
    if (!operationName) { res.status(400).json({ error: 'operationName required' }); return }

    const opRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    })
    const op = await opRes.json()
    if (!opRes.ok) {
      const msg = op?.error?.message || `Veo poll error ${opRes.status}`
      res.status(opRes.status).json({ error: msg }); return
    }
    if (!op.done) { res.json({ done: false }); return }
    if (op.error) { res.json({ done: true, error: op.error.message || 'Veo generation failed' }); return }

    const uri = op?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    if (!uri) { res.json({ done: true, error: 'Veo finished but returned no video' }); return }

    // Download needs the API key, so hand the MP4 back as base64.
    const vidRes = await fetch(uri, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(90_000) })
    if (!vidRes.ok) { res.json({ done: true, error: `Video download failed (${vidRes.status})` }); return }
    const buf = Buffer.from(await vidRes.arrayBuffer())
    res.json({ done: true, videoData: buf.toString('base64'), mimeType: 'video/mp4' })
  } catch (e) {
    console.error('[notebook]', e)
    res.status(500).json({ error: 'Veo poll failed' })
  }
})

export default router
