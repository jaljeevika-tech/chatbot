# FieldFlow AI Upgrade Plan

**Goal:** better accuracy on the outputs funders and the public read, without raising cost on the high-volume features.

**Two moves:**
1. Upgrade every Gemini text call from the 2.5 generation to the current Gemini models.
2. Add Claude as a second provider **only** for the features where quality matters most, with Gemini kept as the automatic fallback.

**Out of scope (stays on Gemini):** WhatsApp bot and NLP, voice-note transcription, data-quality checks, Notebook, TTS, image generation, social posts and other short or high-volume calls.

---

## Ground rules

- **Measure before switching.** No feature moves to Claude without winning a side-by-side test on real FieldFlow data.
- **One gateway.** All model calls go through `lib/ai/runAI.js`, so org policy, budget, PII redaction, logging and the circuit breaker apply to every call.
- **Gemini is always the fallback.** If Claude errors or its circuit breaker opens, the request falls back to Gemini and the user still gets an output.
- **No DB migration without explicit sign-off**, even additive ones.
- **Verify with a real build:** `npm run build`, then load it in a browser, not just `tsc`.

---

## Phase 0 — Baseline and test set (1–2 days)

| Task | Detail |
|---|---|
| Record today's numbers | From `usage_events` and `ai_interactions`: cost, latency and call volume per feature over the last 30 days. |
| Build a test set (real Jaljeevika data) | 3 Content Hub Org reports, 2 Impact reports, 2 Newsletters, 3 donor/annual reports, 5 messy upload files (PDF, Word, odd Excel) for `ai-extract`, 10 Story Finder runs, 3 Report Writer refine jobs. |
| Write the scoring rubric | Number accuracy against MIS/DB (each figure checked), rule compliance (do's and don'ts from the report prompts), invented facts (count), length target met (Org report 10–15 pages), readability (1–5, scored by a program person), cost, latency. |

**Exit:** baseline sheet and test set saved.

## Phase 1 — Put every model name in one place (2–3 days, no behaviour change)

Model IDs are hard-coded in about 15 files today. Create `lib/ai/models.js` with named tiers:

| Tier | Used for | Today |
|---|---|---|
| `FAST` | NLP, extraction, short summaries | `gemini-2.5-flash` |
| `SMART` | long and important reports | `gemini-2.5-pro` |
| `WRITER` | the Claude-candidate features (see Phase 5) | `gemini-2.5-pro` for now |
| `VISION` | photo ↔ text check, image reading | `gemini-2.5-flash` |
| `TTS` | podcast and video voices | `lib/tts.js` (unchanged) |
| `IMAGE` | Video Overview pictures | `gemini-2.5-flash-image` / Imagen 3 |

Files to repoint at `models.js`: `lib/gemini.js`, `lib/ai/runAI.js`, `lib/nlp.js`, `lib/voiceTranscribe.js`, `lib/memoryExtractor.js`, `lib/performanceReview/narrator.js`, `routes/reports.routes.js`, `routes/story-finder.routes.js`, `routes/notebook.routes.js`, `services/notebook/index.js`, `services/report-writer/index.js`, and **`vite.config.ts`**. The dev server has its own copy of the AI routes with `gemini-2.5-pro` hard-coded; if it isn't updated, local and production behaviour will drift apart.

Also move the price table in `lib/usageTracker.js` (Gemini prices dated May 2025) into `models.js`, priced per model.

**Exit:** build passes, every feature behaves the same, and `grep "gemini-2"` finds matches only in `models.js`.

## Phase 2 — Upgrade Gemini 2.5 → current generation (2–3 days)

1. Look up the current Flash and Pro model IDs and prices in Google's docs. Don't guess; the TTS code already uses `gemini-3.8-flash-tts`.
2. Check request parameters that changed between generations, especially the thinking settings (`thinkingConfig.thinkingBudget` is used throughout).
3. Switch `FAST` first, check the WhatsApp NLP path still answers within the 9 s timeout, then switch `SMART`.
4. Run the Phase 0 test set on old vs new Gemini, and update `usageTracker` prices.
5. **Apps Script (`appscript/Code.gs`, `gemini-2.0-flash`):** confirm whether it's still used. Upgrade it if so, delete it if not.

**Exit:** all text features on current Gemini, test-set scores equal or better, cost known.

## Phase 3 — Add Claude as a provider (3–4 days)

| Task | Detail |
|---|---|
| Provider module | `lib/ai/providers/claude.js` using `@anthropic-ai/sdk`: a JSON call and a streaming call. Map Claude's stream events to the **same SSE `{ text }` chunks** the frontend already reads, so the frontend needs no change. |
| Wire into `runAI.js` | Add a `provider` choice per feature (`gemini` \| `claude`), its own circuit breaker (`_claudeCB`), and automatic fallback to Gemini with `fallback_reason` logged. `ai_interactions.provider` already exists, so set it to `'claude'`. |
| Model choice | `claude-sonnet-5-5` by default, and `claude-opus-5-5` only for the Content Hub Org report if the test shows it's worth the cost. |
| Prompt caching | The long system prompts (Org report, Newsletter, Impact) repeat on every call. Cache them to cut cost and latency. |
| Secrets | Add `ANTHROPIC_API_KEY` to Secret Manager, the `lib/secretManager.js` list, `.github/workflows/deploy.yml`, `app.yaml.example` and `.env`. Check `gcloud meta list-files-for-upload` before deploying (`.gcloudignore` trap). |
| Cost tracking | Add Claude rates (from Anthropic's current pricing page) to `models.js` and `usageTracker`, so the superadmin billing view shows a per-provider breakdown. |
| On/off switch | **Option A (recommended to start):** an env var, `AI_WRITER_PROVIDER=claude`, with no migration. **Option B (later):** a per-org toggle in AI Settings, which needs a DB column and therefore a migration and your sign-off. |

**Exit:** Claude callable through `runAI` behind the switch, fallback tested by pulling the key, and the build loads in a browser.

## Phase 4 — Side-by-side test and decision (2–3 days)

Run the Phase 0 test set through **current Gemini Pro** and **Claude Sonnet 5.5** (plus Opus 5.5 for the Org report only). Score blind with the rubric.

**Rule:** a feature moves to Claude only if it clearly wins on accuracy or invented facts **and** the extra cost per report is acceptable. Otherwise it stays on (upgraded) Gemini.

**Exit:** one-page results table with a decision per feature.

## Phase 5 — Roll out the winners (1–2 weeks)

Several of these routes **call Gemini directly today and bypass `runAI`**. They must be moved onto `runAI.stream` first, which also fixes policy, budget and redaction not being applied to them.

| Order | Feature | Files | Notes |
|---|---|---|---|
| 1 | Content Hub Org report, Impact report, Newsletter | `routes/reports.routes.js` (`/get-ai-report`), `lib/gemini.js` `pickReportUrl` | Replace the keyword-based Pro picker with the `WRITER` tier. |
| 2 | Donor, annual, board, grant, SROI and ToC reports | same route (Pro-keyword path) | Same switch. |
| 3 | Report Writer (draft, refine, polish, reflect) | `routes/report-writer.routes.js`, `services/report-writer/index.js` | The Cloud Run microservice needs its own key and redeploy. |
| 4 | Upload any format | `routes/ai-extract.routes.js` | Try sending PDFs directly to Claude vs today's text-extract path, then pick the more accurate. |
| 5 | Story Finder | `routes/story-finder.routes.js` | Keep the `grounding_score` check. |
| 6 | Flow generator, performance review narrator | `routes/flow-generator.routes.js`, `lib/performanceReview/narrator.js` | Low volume; only if Phase 4 showed a win. |

**Pilot:** Jaljeevika org only for 1 week, then all orgs.

## Phase 6 — Privacy and docs (1 day, alongside Phase 5)

- `docs/PrivacyNotice.md` currently names **no AI processor at all, not even Google/Gemini**. Add both Google and Anthropic, what data each receives, and that PII is redacted first.
- Update `docs/GovernanceRequirements.md` and `docs/Technical.md` (the model table at about line 337).
- Save the decisions to project memory.

## Phase 7 — Monitor (2 weeks after rollout)

Track per feature: cost per output, latency, Claude → Gemini fallback rate, and thumbs up/down from `/api/ai/feedback`. Roll back any feature with the env switch if quality or cost goes the wrong way.

---

## Timeline

| Week | Work |
|---|---|
| 1 | Phase 0 + Phase 1 |
| 2 | Phase 2 (Gemini upgrade) + Phase 3 (Claude provider) |
| 3 | Phase 4 (test and decide) + start Phase 5 |
| 4 | Finish Phase 5 + Phase 6, Jaljeevika pilot |
| 5–6 | Phase 7 monitoring, roll out to all orgs |

Phases 1–2 are worth doing **even if Claude is never adopted**.

## Decisions needed from you

1. **On/off switch:** env var only (no migration) or per-org toggle (needs a migration)?
2. **Budget:** maximum acceptable extra cost per report, or per month, for Claude.
3. **Opus for the Org report:** allow it if it wins, or cap at Sonnet?
4. **Apps Script dashboard:** still in use?

## Risks

| Risk | Mitigation |
|---|---|
| Claude costs more per report | Use it only on low-volume, high-stakes features; prompt caching; budget check in `runAI`. |
| Prompts tuned for Gemini underperform on Claude | Phase 4 tests each feature, and prompts can be adjusted per provider. |
| Output style changes between primary and fallback | Log the fallback reason, and keep the fallback rate low with the circuit breaker. |
| Dev server (`vite.config.ts`) drifts from production | Phase 1 points it at `models.js`. |
| Deploy misses the new key or files | Secret Manager + `gcloud meta list-files-for-upload` check before deploy. |
