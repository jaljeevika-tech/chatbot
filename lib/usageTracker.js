// Per-call AI cost tracking: one fire-and-forget usage_events row per call, queried
// via /api/superadmin/billing. Conservative estimate: input ≈ chars / 4 tokens and
// output = the full maxOutputTokens budget (Gemini pricing, May 2025).

import { getPool } from '../db/pool.js'

// ── Pricing constants ─────────────────────────────────────────────────────────
const PRICE = {
  pro:    { input: 1.25  / 1_000_000, output: 10.00 / 1_000_000 },
  flash:  { input: 0.15  / 1_000_000, output:  0.60 / 1_000_000 },
  imagen: { perImage: 0.03 },
  tts:    { perChar:  0.10 / 1_000_000 },   // $0.10 per 1M chars
}

// ── Table bootstrap ────────────────────────────────────────────────────────────
let _tableReady = false
let _ensurePromise = null   // dedupes concurrent calls

async function _createTable() {
  const pool = getPool()
  // Separate query() calls — node-postgres rejects multi-statement strings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id                BIGSERIAL     PRIMARY KEY,
      org_id            TEXT          NOT NULL,
      service           TEXT          NOT NULL,
      model_tier        TEXT          NOT NULL DEFAULT 'flash',
      est_input_tokens  INTEGER       NOT NULL DEFAULT 0,
      max_output_tokens INTEGER       NOT NULL DEFAULT 0,
      est_cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
      was_downgraded    BOOLEAN       NOT NULL DEFAULT false,
      source            TEXT          NOT NULL DEFAULT 'live',
      ref_id            TEXT,
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `)
  // Columns first for tables created by older versions; the indexes below need ref_id
  await pool.query(`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'`)
  await pool.query(`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ref_id TEXT`)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS usage_events_org_date ON usage_events(org_id, created_at DESC)`
  )
  await pool.query(
    `CREATE INDEX IF NOT EXISTS usage_events_date ON usage_events(created_at DESC)`
  )
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS usage_events_ref_id ON usage_events(ref_id) WHERE ref_id IS NOT NULL`
  )
}

async function _ensureTable() {
  if (_tableReady) return
  if (_ensurePromise) return _ensurePromise
  _ensurePromise = (async () => {
    try {
      await _createTable()
      _tableReady = true
    } catch (e) {
      // 42P07 = already exists, which is fine
      if (e.code === '42P07' || /already exists/i.test(e.message ?? '')) {
        _tableReady = true
      } else {
        console.warn('[usageTracker] ensureTable failed:', e.message)
        // Leave _tableReady false so the next call retries
      }
    } finally {
      _ensurePromise = null
    }
  })()
  return _ensurePromise
}

/** Run at startup so the first AI request doesn't pay the DDL cost. Idempotent. */
export async function initUsageTracking() {
  await _ensureTable()
}

/**
 * Record one AI call. Fire-and-forget: never throws or blocks.
 * @param {object}  opts
 * @param {string}  opts.service            - e.g. 'report_ai' | 'social_post' | 'notebook_chat' …
 * @param {'pro'|'flash'|'imagen'|'tts'} [opts.model='flash']
 * @param {number}  [opts.inputLength=0]    - total chars in prompt + system (Gemini models)
 * @param {number}  [opts.imageCount=1]     - Imagen only
 * @param {number}  [opts.ttsChars=0]       - TTS only
 */
export function trackUsage(orgId, opts = {}) {
  if (!orgId) return
  ;(async () => {
    try {
      await _ensureTable()

      // Table creation failed: skip silently
      if (!_tableReady) return

      const {
        service         = 'unknown',
        model           = 'flash',
        inputLength     = 0,
        maxOutputTokens = 0,
        imageCount      = 1,
        ttsChars        = 0,
        wasDowngraded   = false,
      } = opts

      let estInputTokens = 0, estCostUsd = 0

      if (model === 'imagen') {
        estCostUsd = (imageCount || 1) * PRICE.imagen.perImage
      } else if (model === 'tts') {
        estCostUsd = (ttsChars || 0) * PRICE.tts.perChar
      } else {
        const tier     = model === 'pro' ? 'pro' : 'flash'
        estInputTokens = Math.ceil((inputLength || 0) / 4)
        estCostUsd     = estInputTokens * PRICE[tier].input + (maxOutputTokens || 0) * PRICE[tier].output
      }

      await getPool().query(
        `INSERT INTO usage_events
           (org_id, service, model_tier, est_input_tokens, max_output_tokens, est_cost_usd, was_downgraded)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          String(orgId),
          service,
          model,
          estInputTokens,
          maxOutputTokens || 0,
          +estCostUsd.toFixed(6),
          wasDowngraded,
        ]
      )
    } catch (e) {
      console.warn('[usageTracker] insert failed:', e.message)
    }
  })()
}
