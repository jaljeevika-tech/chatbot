// Shared AI helpers: table bootstrap, memory persistence, interaction recording, feedback.

import { getPool } from '../db/pool.js'
import { invalidateOrgContext } from './aiContext.js'

// ── Table bootstrap (called once at server startup) ───────────────────────────
// node-postgres can't run multiple statements in one query(), so each DDL is separate.
let _ready = false
export async function initAiLayer() {
  if (_ready) return
  const pool = getPool()
  try {
    // 008: base tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_memories (
        id            SERIAL      PRIMARY KEY,
        org_id        TEXT        NOT NULL,
        memory_type   TEXT        NOT NULL,
        subject       TEXT        NOT NULL DEFAULT '',
        content       TEXT        NOT NULL,
        source        TEXT,
        confidence    REAL        NOT NULL DEFAULT 1.0,
        reinforced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ai_memories_upsert_key
        ON ai_memories (org_id, memory_type, subject)`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_memories_org_type
        ON ai_memories (org_id, memory_type)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_interactions (
        id            SERIAL      PRIMARY KEY,
        org_id        TEXT        NOT NULL,
        feature       TEXT        NOT NULL,
        user_message  TEXT,
        ai_response   TEXT,
        feedback      SMALLINT,
        memory_ids    INTEGER[]   NOT NULL DEFAULT '{}',
        tokens_used   INTEGER     NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_interactions_org
        ON ai_interactions (org_id, created_at DESC)`)

    // 009: gateway observability + learning tables
    await pool.query(`ALTER TABLE ai_interactions
      ADD COLUMN IF NOT EXISTS route_used      TEXT,
      ADD COLUMN IF NOT EXISTS confidence      REAL,
      ADD COLUMN IF NOT EXISTS latency_ms      INTEGER,
      ADD COLUMN IF NOT EXISTS cost_usd        NUMERIC(10,6),
      ADD COLUMN IF NOT EXISTS fallback_reason TEXT,
      ADD COLUMN IF NOT EXISTS provider        TEXT`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_interactions_provider
        ON ai_interactions (org_id, provider, created_at DESC)`)
    await pool.query(`ALTER TABLE ai_memories
      ADD COLUMN IF NOT EXISTS status                TEXT    NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS version               INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS source_interaction_id INTEGER
        REFERENCES ai_interactions(id) ON DELETE SET NULL`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_memories_status ON ai_memories (org_id, status)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_learning_candidates (
        id              SERIAL       PRIMARY KEY,
        org_id          TEXT,
        type            TEXT         NOT NULL,
        feature         TEXT         NOT NULL,
        proposed_change JSONB        NOT NULL,
        evidence_count  INTEGER      NOT NULL DEFAULT 0,
        eval_score      REAL,
        status          TEXT         NOT NULL DEFAULT 'pending',
        reviewed_by     TEXT,
        review_note     TEXT,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        reviewed_at     TIMESTAMPTZ,
        promoted_at     TIMESTAMPTZ
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_candidates_status
        ON ai_learning_candidates (status, created_at DESC)`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_candidates_org_feature
        ON ai_learning_candidates (org_id, feature, status)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_rule_versions (
        id           SERIAL       PRIMARY KEY,
        org_id       TEXT,
        feature      TEXT         NOT NULL,
        rule_type    TEXT         NOT NULL,
        version      INTEGER      NOT NULL DEFAULT 1,
        config       JSONB        NOT NULL,
        eval_metrics JSONB,
        active       BOOLEAN      NOT NULL DEFAULT false,
        promoted_by  TEXT,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        UNIQUE (org_id, feature, rule_type, version)
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_rule_versions_active
        ON ai_rule_versions (org_id, feature, rule_type) WHERE active = true`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        org_id              TEXT         PRIMARY KEY,
        external_enabled    BOOLEAN      NOT NULL DEFAULT true,
        local_model_url     TEXT,
        local_model_name    TEXT,
        budget_usd_daily    NUMERIC(8,4) NOT NULL DEFAULT 5.0,
        feature_policies    JSONB        NOT NULL DEFAULT '{}',
        updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_by          TEXT
      )`)

    // 010: worker master data extensions
    await pool.query(`ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password     TEXT,
      ADD COLUMN IF NOT EXISTS employee_id  TEXT,
      ADD COLUMN IF NOT EXISTS designation  TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS project_ids  TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS exit_date    DATE`)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_org
        ON users (org_id, employee_id)
        WHERE employee_id IS NOT NULL`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          BIGSERIAL    PRIMARY KEY,
        org_id      UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_uid   TEXT         NOT NULL,
        actor_name  TEXT,
        action      TEXT         NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        diff        JSONB,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS audit_log_org
        ON audit_log (org_id, created_at DESC)`)

    // 011: project deliverables for impact data upload
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_deliverables (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id      UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project     TEXT         NOT NULL,
        indicator   TEXT         NOT NULL,
        planned     NUMERIC,
        achieved    NUMERIC,
        period      TEXT         NOT NULL,
        data_type   TEXT         NOT NULL DEFAULT 'output',
        source_file TEXT,
        uploaded_by TEXT,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_deliverables_org
        ON project_deliverables (org_id, project, period)`)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS project_deliverables_upsert_key
        ON project_deliverables (org_id, project, indicator)`)
    await pool.query(`ALTER TABLE project_deliverables
      ADD COLUMN IF NOT EXISTS updated_by TEXT`)

    // ── WhatsApp v2: human handoff (assigned_to + status='handoff') ──────────
    await pool.query(`ALTER TABLE wa_sessions
      ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS wa_sessions_status_idx
        ON wa_sessions (org_id, status)`)

    // ON CONFLICT (wa_message_id) needs a non-partial unique index; NULLs are
    // distinct, so outbound rows (NULL id) are fine.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_wa_message_id_key
        ON wa_messages (wa_message_id)`)

    // Flow-level UX toggle: progress indicator on questions
    await pool.query(`ALTER TABLE wa_flows
      ADD COLUMN IF NOT EXISTS show_progress BOOLEAN NOT NULL DEFAULT false`)

    // Webhook dead-letter: failed inbound events are kept for inspection/retry
    // rather than lost after the 200 ACK to Meta.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wa_dead_letter (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id      UUID,
        wa_id       TEXT,
        event_type  TEXT,
        payload     JSONB NOT NULL,
        error_msg   TEXT,
        error_stack TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        retried_at  TIMESTAMPTZ,
        retried_ok  BOOLEAN
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS wa_dead_letter_org_pending
        ON wa_dead_letter (org_id, created_at DESC)
        WHERE retried_at IS NULL`)

    // Action Plan improvements — notes per indicator cell + last-editor tracking
    await pool.query(`ALTER TABLE project_deliverables
      ADD COLUMN IF NOT EXISTS notes TEXT`)
    await pool.query(`ALTER TABLE project_deliverables
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)

    // Multi-project action plans; src/data/actionPlanData.json seeds the Kosi plan.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS action_plans (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key  TEXT NOT NULL,
        name         TEXT NOT NULL,
        year         INT,
        start_month  INT  DEFAULT 4,
        locations    TEXT[] NOT NULL DEFAULT '{}',
        activities   JSONB  NOT NULL DEFAULT '[]'::jsonb,
        uploaded_by  TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        active       BOOLEAN NOT NULL DEFAULT true,
        UNIQUE (org_id, project_key)
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS action_plans_org_active
        ON action_plans (org_id, active, updated_at DESC)`)

    // Seed the Kosi plan from the bundled JSON for any org that has Kosi cell data
    // but no action_plans row yet. Idempotent.
    try {
      const fs = await import('fs')
      const path = await import('path')
      const url  = await import('url')
      const dir  = path.dirname(url.fileURLToPath(import.meta.url))
      const seedPath = path.resolve(dir, '..', 'src', 'data', 'actionPlanData.json')
      if (fs.existsSync(seedPath)) {
        const seedJson = fs.readFileSync(seedPath, 'utf8')
        const seedData = JSON.parse(seedJson)
        const locations = Array.from(new Set(seedData.flatMap(a => (a.locations || []).map(l => l.location))))
        const { rows: orgs } = await pool.query(`
          SELECT DISTINCT org_id FROM project_deliverables WHERE project = 'kosi_action_plan_2026'
        `).catch(() => ({ rows: [] }))
        for (const { org_id } of orgs) {
          await pool.query(`
            INSERT INTO action_plans (org_id, project_key, name, year, start_month, locations, activities, uploaded_by)
            VALUES ($1, 'kosi_action_plan_2026', 'Kosi Sahjivan 2026', 2026, 4, $2, $3, 'system-seed')
            ON CONFLICT (org_id, project_key) DO NOTHING
          `, [org_id, locations, JSON.stringify(seedData)])
        }
        if (orgs.length) console.log(`[startup] action_plans seeded for ${orgs.length} org(s)`)
      }
    } catch (e) {
      console.warn('[startup] action_plans seed skipped:', e.message)
    }

    // Portfolio Overview / Org Dashboard fields on action_plans (donor, region,
    // budget, health/compliance overrides). See db/migrations/018_project_portfolio_fields.sql.
    await pool.query(`ALTER TABLE action_plans
      ADD COLUMN IF NOT EXISTS donor                TEXT,
      ADD COLUMN IF NOT EXISTS region                TEXT,
      ADD COLUMN IF NOT EXISTS budget                NUMERIC,
      ADD COLUMN IF NOT EXISTS end_date              DATE,
      ADD COLUMN IF NOT EXISTS health_override       TEXT CHECK (health_override IN ('green', 'amber', 'red')),
      ADD COLUMN IF NOT EXISTS compliance_override    TEXT CHECK (compliance_override IN ('green', 'amber', 'red'))`)

    // Document Vault. See db/migrations/019_document_vault.sql.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_documents (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key  TEXT NOT NULL,
        vault_tab    TEXT NOT NULL DEFAULT 'legal' CHECK (vault_tab IN ('legal', 'financial', 'progress', 'knowledge')),
        name         TEXT NOT NULL,
        file_type    TEXT,
        storage_path TEXT NOT NULL,
        uploaded_by  TEXT,
        status       TEXT NOT NULL DEFAULT 'indexed',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_documents_org_proj
        ON project_documents (org_id, project_key, vault_tab)`)

    // Beneficiaries. See db/migrations/020_beneficiaries.sql.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS beneficiaries (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key    TEXT NOT NULL,
        name           TEXT NOT NULL,
        gender         TEXT,
        location       TEXT,
        category       TEXT,
        enrolled_date  DATE,
        status         TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Completed', 'Dropped')),
        custom_data    JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS beneficiaries_org_proj
        ON beneficiaries (org_id, project_key, status)`)

    // Compliance Calendar. project_key nullable — org-level items (FCRA, 80G)
    // aren't tied to any one project. See db/migrations/021_compliance_items.sql.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_items (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key    TEXT,
        item           TEXT NOT NULL,
        due_date       DATE,
        manual_status  TEXT CHECK (manual_status IN ('overdue', 'upcoming', 'valid')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS compliance_items_org_proj
        ON compliance_items (org_id, project_key, due_date)`)

    // Financial Tracker: budget-by-head + monthly utilisation certificates.
    // See db/migrations/022_financial_tracker.sql.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS budget_heads (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key  TEXT NOT NULL,
        head         TEXT NOT NULL,
        budget       NUMERIC NOT NULL DEFAULT 0,
        utilised     NUMERIC NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS budget_heads_org_proj
        ON budget_heads (org_id, project_key)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS utilisation_certificates (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_key    TEXT NOT NULL,
        period_month   DATE NOT NULL,
        submitted_date DATE,
        status         TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Submitted')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS utilisation_certificates_org_proj
        ON utilisation_certificates (org_id, project_key, period_month DESC)`)

    // RLS org isolation for the portfolio-era tables, same policy as action_plans.
    for (const t of ['project_documents', 'beneficiaries', 'compliance_items', 'budget_heads', 'utilisation_certificates']) {
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = '${t}' AND policyname = '${t}_org_isolation') THEN
            ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
            CREATE POLICY ${t}_org_isolation ON ${t}
              USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
          END IF;
        END $$`)
    }

    console.log('[startup] AI layer tables ready')
    _ready = true // every statement is idempotent, so a failed run retries in full
  } catch (e) {
    console.warn('[startup] AI layer init error:', e.message)
  }
}

/**
 * Upsert a memory keyed by (org_id, memory_type, subject), refreshing confidence / reinforced_at.
 * @param {string}  memoryType  — 'org_context' | 'worker_insight' | 'project_pattern' | 'language_pref' | 'barrier_pattern'
 * @param {string}  subject     — worker name, project, region, etc. Pass '' for org-level entries.
 * @param {string}  [source]    — 'toc_analysis' | 'notebook' | 'rw' | 'whatsapp' | 'manual'
 * @returns {Promise<number|null>}  row id
 */
export async function reinforceMemory(orgId, memoryType, subject = '', content, confidence = 1.0, source = null) {
  if (!orgId || !content) return null
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO ai_memories (org_id, memory_type, subject, content, confidence, source, reinforced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (org_id, memory_type, subject)
       DO UPDATE SET
         content       = EXCLUDED.content,
         confidence    = GREATEST(ai_memories.confidence, EXCLUDED.confidence),
         source        = EXCLUDED.source,
         reinforced_at = NOW(),
         updated_at    = NOW()
       RETURNING id`,
      [orgId, memoryType, subject, content, confidence, source]
    )
    invalidateOrgContext(orgId)
    return rows[0]?.id ?? null
  } catch (e) {
    console.warn('[aiAgent] reinforceMemory error:', e.message)
    return null
  }
}

/**
 * Insert the interaction row before streaming so the client gets its id for
 * feedback; finish with updateInteraction().
 * @param {string}   feature   — 'assistant' | 'toc' | 'notebook' | 'rw' | 'whatsapp'
 */
export async function createInteraction(orgId, feature, userMsg, memoryIds = []) {
  if (!orgId) return null
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO ai_interactions (org_id, feature, user_message, memory_ids)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orgId, feature, userMsg ?? '', memoryIds]
    )
    return rows[0]?.id ?? null
  } catch (e) {
    console.warn('[aiAgent] createInteraction error:', e.message)
    return null
  }
}

/** Store the final AI response text on an interaction row. */
export async function updateInteraction(interactionId, aiResponse, tokensUsed = 0) {
  if (!interactionId) return
  try {
    const pool = getPool()
    await pool.query(
      `UPDATE ai_interactions SET ai_response = $1, tokens_used = $2 WHERE id = $3`,
      [aiResponse, tokensUsed, interactionId]
    )
  } catch (e) {
    console.warn('[aiAgent] updateInteraction error:', e.message)
  }
}

/**
 * Set thumbs up (1) / down (-1) on an interaction. ai_interactions.id is a global,
 * enumerable SERIAL, so the update is scoped to orgId — the caller's server-verified
 * req.user.orgId, never client input.
 */
export async function updateFeedback(interactionId, feedback, orgId) {
  if (!interactionId || !orgId) return
  try {
    const pool = getPool()
    await pool.query(
      `UPDATE ai_interactions SET feedback = $1 WHERE id = $2 AND org_id = $3`,
      [feedback, interactionId, orgId]
    )
  } catch (e) {
    console.warn('[aiAgent] updateFeedback error:', e.message)
  }
}
