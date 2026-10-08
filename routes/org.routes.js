// routes/org.routes.js — Organisation metadata + subscription routes
// GET  /api/org/metadata
// PUT  /api/org/metadata           (admin — partial metadata patch: projects, etc.)
// PUT  /api/org/branding           (admin — logo upload + org_name/tagline/dashboard_title)
// PUT  /api/org/content-hub-permissions
// PUT  /api/org/tab-permissions
// PUT  /api/org/report-categories
// PUT  /api/org/user-access
// GET  /api/subscription

import { Router } from 'express'
import { getPool } from '../db/pool.js'
import { invalidateOrgMeta } from '../lib/orgMetaCache.js'
import { stripSecretMeta } from '../lib/secretMeta.js'
import { computeAccess } from '../lib/subscriptionGuard.js'

const router = Router()

// Secrets stored in organizations.metadata must never reach the browser: every role
// calls this endpoint, and e.g. glific_webhook_secret would let an employee forge webhooks.

// ── GET /api/org/metadata — return current org's metadata + subscription info ──
router.get('/org/metadata', async (req, res) => {
  if (!req.user.orgId) return res.status(400).json({ error: 'No orgId in token claims' })
  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT o.id, o.slug, o.name, o.metadata,
              o.subscription_status, o.subscription_expires_at, o.billing_email, o.billing_notes,
              p.id AS plan_id, p.name AS plan_name, p.slug AS plan_slug,
              p.description AS plan_description, p.price_monthly, p.max_users,
              p.ai_enabled, p.sort_order, p.is_active AS plan_is_active, to_jsonb(p)->'apps' AS plan_apps
       FROM organizations o
       LEFT JOIN plans p ON p.id = o.plan_id
       WHERE o.id = $1`,
      [req.user.orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })
    const row = rows[0]
    const subscription = {
      plan: row.plan_id ? {
        id: row.plan_id, name: row.plan_name, slug: row.plan_slug,
        description: row.plan_description, price_monthly: Number(row.price_monthly),
        max_users: row.max_users, ai_enabled: row.ai_enabled, apps: row.plan_apps ?? null,
        sort_order: row.sort_order, is_active: row.plan_is_active,
      } : null,
      status:        row.subscription_status  || 'inactive',
      expires_at:    row.subscription_expires_at ? row.subscription_expires_at.toISOString() : null,
      billing_email: row.billing_email || '',
      billing_notes: row.billing_notes || '',
      // ok | grace | read_only — drives the expiry / suspension banner
      access:        computeAccess(row),
    }
    res.json({ orgId: row.id, slug: row.slug, name: row.name, metadata: stripSecretMeta(row.metadata), subscription })
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/subscription — org admin views their own subscription ─────────────
router.get('/subscription', async (req, res) => {
  if (!req.user.orgId) return res.status(400).json({ error: 'No orgId' })
  try {
    const { rows } = await getPool().query(
      `SELECT o.subscription_status, o.subscription_expires_at, o.billing_email,
              p.id AS plan_id, p.name AS plan_name, p.slug AS plan_slug,
              p.description, p.price_monthly, p.max_users, p.ai_enabled
       FROM organizations o LEFT JOIN plans p ON p.id = o.plan_id
       WHERE o.id = $1`,
      [req.user.orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Org not found' })
    res.json(rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── PUT /api/org/content-hub-permissions — admin saves content hub role permissions ──
router.put('/org/content-hub-permissions', async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can update permissions' })
  }
  const { permissions } = req.body
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'permissions object required' })
  }
  try {
    await getPool().query(
      `UPDATE organizations
       SET metadata = jsonb_set(metadata, '{contentHubPermissions}', $1::jsonb, true)
       WHERE id = $2`,
      [JSON.stringify(permissions), req.user.orgId]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error' })
  }
})

// ── PUT /api/org/user-access — admin saves per-user tab + content hub overrides ──
router.put('/org/user-access', async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can update user access' })
  }
  const { phone, tabPermissions, contentHubPermissions } = req.body
  if (!phone) return res.status(400).json({ error: 'phone required' })

  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT metadata FROM organizations WHERE id = $1`, [req.user.orgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'Org not found' })
    const meta = rows[0].metadata || {}

    // If null passed → remove override (reset to role defaults)
    const userTabPerms  = { ...(meta.userTabPermissions  || {}) }
    const userChPerms   = { ...(meta.userContentHubPermissions || {}) }

    if (tabPermissions === null) {
      delete userTabPerms[phone]
    } else if (Array.isArray(tabPermissions)) {
      userTabPerms[phone] = tabPermissions
    }

    if (contentHubPermissions === null) {
      delete userChPerms[phone]
    } else if (Array.isArray(contentHubPermissions)) {
      userChPerms[phone] = contentHubPermissions
    }

    await pool.query(
      `UPDATE organizations
       SET metadata = metadata
         || jsonb_build_object('userTabPermissions', $1::jsonb)
         || jsonb_build_object('userContentHubPermissions', $2::jsonb)
       WHERE id = $3`,
      [JSON.stringify(userTabPerms), JSON.stringify(userChPerms), req.user.orgId]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error' })
  }
})

// ── PUT /api/org/tab-permissions — admin saves tab visibility per role ────────
router.put('/org/tab-permissions', async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can update tab permissions' })
  }
  const { permissions } = req.body
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'permissions object required' })
  }
  try {
    await getPool().query(
      `UPDATE organizations
       SET metadata = jsonb_set(metadata, '{tabPermissions}', $1::jsonb, true)
       WHERE id = $2`,
      [JSON.stringify(permissions), req.user.orgId]
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error' })
  }
})

// ── PUT /api/org/report-categories — admin manages the Document Vault's ──────
// report categories. Invalidates lib/orgMetaCache.js, which documents' AI tagging reads.
router.put('/org/report-categories', async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can update report categories' })
  }
  const { categories } = req.body
  if (!Array.isArray(categories) || !categories.every(c => typeof c === 'string' && c.trim())) {
    return res.status(400).json({ error: 'categories must be an array of non-empty strings' })
  }
  const cleaned = [...new Set(categories.map(c => c.trim()))]
  try {
    await getPool().query(
      `UPDATE organizations
       SET metadata = jsonb_set(metadata, '{reportCategories}', $1::jsonb, true)
       WHERE id = $2`,
      [JSON.stringify(cleaned), req.user.orgId]
    )
    invalidateOrgMeta(req.user.orgId)
    res.json({ success: true, categories: cleaned })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error' })
  }
})

// ── PUT /api/org/metadata — admin updates partial org metadata fields ─────────
// Accepted fields: projects (ProjectDef[])
// Uses jsonb_set to patch only the supplied keys — does NOT overwrite the whole blob.
router.put('/org/metadata', async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can update org metadata' })
  }

  const ALLOWED_KEYS = ['projects']
  const pool = getPool()

  try {
    let query = `SELECT metadata FROM organizations WHERE id = $1`
    const { rows } = await pool.query(query, [req.user.orgId])
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' })

    const body = req.body || {}
    const patches = ALLOWED_KEYS.filter(k => k in body)
    if (!patches.length) return res.status(400).json({ error: 'No updatable fields provided. Accepted: ' + ALLOWED_KEYS.join(', ') })

    // Chain jsonb_set calls: metadata || jsonb_build_object(k1, v1) || ...
    const setClauses = patches.map((k, i) => `jsonb_build_object('${k}', $${i + 2}::jsonb)`).join(' || ')
    await pool.query(
      `UPDATE organizations SET metadata = metadata || ${setClauses} WHERE id = $1`,
      [req.user.orgId, ...patches.map(k => JSON.stringify(body[k]))]
    )

    res.json({ success: true, updated: patches })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error' })
  }
})

// Metadata is fetched whole on every page load, so keep logos small. SVG is
// rejected because a data-URI SVG can carry script.
const MAX_LOGO_BYTES = 1.5 * 1024 * 1024
const LOGO_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// ── PUT /api/org/branding — admin edits their own org's branding ─────────────
// Self-service counterpart to the superadmin editor. logo_url is stored in
// metadata.branding.logo_url (a data: URI works wherever a URL does); '' resets it.
router.put('/org/branding', async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can update branding' })
  }

  const ALLOWED_KEYS = ['org_name', 'tagline', 'dashboard_title', 'logo_url']
  const body = req.body || {}
  const patch = {}

  for (const key of ALLOWED_KEYS) {
    if (!(key in body)) continue
    const value = body[key]
    if (typeof value !== 'string') {
      return res.status(400).json({ error: `${key} must be a string` })
    }
    if (key === 'logo_url' && value) {
      const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(value)
      if (!match) {
        return res.status(400).json({ error: 'logo_url must be a data: URI (upload an image) or empty string to clear' })
      }
      const [, mimeType, base64Payload] = match
      if (!LOGO_MIME_ALLOWLIST.includes(mimeType)) {
        return res.status(400).json({ error: `Unsupported logo type "${mimeType}" — use PNG, JPEG, WEBP or GIF` })
      }
      // Upper-bound decoded size from the base64 length, without decoding.
      const approxBytes = base64Payload.length * 0.75
      if (approxBytes > MAX_LOGO_BYTES) {
        return res.status(400).json({ error: `Logo is too large (max ${Math.round(MAX_LOGO_BYTES / 1024)}kb) — please use a smaller image` })
      }
    }
    patch[key] = value
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'No updatable fields provided. Accepted: ' + ALLOWED_KEYS.join(', ') })
  }

  try {
    // Nest jsonb_set calls so sibling keys under `branding` (e.g. theme) survive;
    // a flat `||` merge would replace the whole object.
    const keys = Object.keys(patch)
    let setExpr = 'metadata'
    keys.forEach((k, i) => {
      setExpr = `jsonb_set(${setExpr}, '{branding,${k}}', $${i + 2}::jsonb)`
    })

    await getPool().query(
      `UPDATE organizations SET metadata = ${setExpr} WHERE id = $1`,
      [req.user.orgId, ...keys.map(k => JSON.stringify(patch[k]))]
    )
    invalidateOrgMeta(req.user.orgId)
    res.json({ success: true, updated: Object.keys(patch) })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error' })
  }
})

export default router
