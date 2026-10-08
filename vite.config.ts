import 'dotenv/config'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'http'
import { createSign } from 'crypto'
import { BigQuery } from '@google-cloud/bigquery'
import fs from 'fs'
import admin from 'firebase-admin'
// @ts-ignore — no type declarations for pool.js
import { getPool } from './db/pool.js'
// @ts-ignore — plain JS module
import { maskSecretMeta, prepareSecretPatch, stripSecretMeta } from './lib/secretMeta.js'

// ── Firebase Admin (dev) ──────────────────────────────────────
let _fbReady = false
function ensureFirebase() {
  if (_fbReady) return
  _fbReady = true
  if (!admin.apps.length) {
    try {
      const keyPath = './firebase-adminsdk.json'
      const keyJson = fs.existsSync(keyPath) ? JSON.parse(fs.readFileSync(keyPath, 'utf8')) : null
      admin.initializeApp({
        credential: keyJson
          ? admin.credential.cert(keyJson)
          : admin.credential.applicationDefault(),
        projectId: 'chatbot-5304f',
      })
    } catch (e) {
      console.error('[firebase-admin] init failed:', e)
    }
  }
}

// For local dev: decode JWT payload without signature verification
function decodeJwt(token: string): Record<string, any> | null {
  try {
    const payload = token.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch { return null }
}

async function verifyToken(req: IncomingMessage): Promise<Record<string, any> | null> {
  // HIGH-2: Unverified JWT fallback MUST NOT run outside local dev
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[vite.config.ts] verifyToken must not be called in production — use server.js')
  }

  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice(7)

  // Try Admin SDK first (full verification)
  try {
    ensureFirebase()
    return await admin.auth().verifyIdToken(token)
  } catch (e) {
    console.warn('[verifyToken] Admin SDK failed, falling back to JWT decode:', (e as any).message)
  }

  // Fallback: decode without verification (local dev only — guarded above)
  const decoded = decodeJwt(token)
  if (!decoded) return null
  console.warn('[verifyToken] Using unverified JWT decode — local dev only')
  return decoded
}

function jsonRes(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let b = ''; req.on('data', (c: Buffer) => { b += c.toString() }); req.on('end', () => resolve(b))
  })
}

// ── Google Sheets write helpers (user management) ─────────────────────────────
// LOW-6: source from env var rather than hardcoding the sheet ID
const USERS_SHEET_ID   = process.env.USERS_SHEET_ID || '14qcsnumtAQp2u8mTkQ-3hvioQ_8RDfweNGEZSsv3HrE'
const USERS_SHEET_NAME = 'Sheet1'

async function getGoogleAccessToken(keyJson: string): Promise<string | null> {
  if (!keyJson) return null
  try {
    const sa  = JSON.parse(keyJson)
    const now = Math.floor(Date.now() / 1000)
    const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const pld = Buffer.from(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
    })).toString('base64url')
    const signer = createSign('RSA-SHA256')
    signer.update(`${hdr}.${pld}`)
    const jwt = `${hdr}.${pld}.${signer.sign(sa.private_key, 'base64url')}`
    const tr  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    })
    const td: any = await tr.json()
    return td.access_token || null
  } catch (e) { console.error('[user-mgmt] token error:', e); return null }
}

function normPhone(p: string) { return String(p || '').replace(/[\s\-]/g, '').replace(/^\+/, '') }

async function findUserRowIndex(token: string, phone: string): Promise<number> {
  const data: any = await (await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${USERS_SHEET_ID}/values/${USERS_SHEET_NAME}!A:B`,
    { headers: { Authorization: `Bearer ${token}` } }
  )).json()
  const rows = (data.values || []) as string[][]
  const target = normPhone(phone)
  for (let i = 1; i < rows.length; i++) {
    if (normPhone(rows[i][1] || '') === target) return i + 1
  }
  return -1
}

// ── Gemini model to use ──────────────────────────────────────
// gemini-2.5-pro: highest quality, 1M token context
const GEMINI_MODEL = 'gemini-2.5-pro'
// MED-9: API key passed via x-goog-api-key header, not URL query string
const GEMINI_URL   = (_key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`

// ── Prompt builder ────────────────────────────────────────────
function buildReportPrompt(userName: string, reportsRaw: Record<string, any>[], filters: Record<string, any>, instruction?: string, language?: string) {
  // Cap to 300 most-recent records to stay within safe token limits
  const reports = reportsRaw.length > 300
    ? reportsRaw.slice(-300)
    : reportsRaw
  const truncatedNote = reportsRaw.length > 300
    ? `\n⚠️ Note: Showing most recent 300 of ${reportsRaw.length} total records.\n`
    : ''

  const totalBeneficiaries = reports.reduce((sum, r) => {
    const n = typeof r.beneficiaries === 'number'
      ? r.beneficiaries
      : parseInt(String(r.beneficiaries ?? '0'), 10)
    return sum + (isNaN(n as number) ? 0 : (n as number))
  }, 0)

  const dateRange = reports.length > 0
    ? `${String(reports[0].timestamp).slice(0, 10)} to ${String(reports[reports.length - 1].timestamp).slice(0, 10)}`
    : 'N/A'

  const activities = reports.map((r, i) => [
    `ID: r${i+1}`,
    `Date: ${new Date(String(r.timestamp)).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    `Location: ${r.location}, ${r.state}`,
    `Project: ${r.project || 'N/A'}`,
    `Area of Intervention: ${r.areaOfIntervention}`,
    `Beneficiaries: ${r.beneficiaries ?? '0'}`,
    `Description: ${r.description}`,
    `Attachment URL: ${r.attachmentUrl || 'None'}`,
  ].join('\n')).join('\n\n---\n\n')

  const filterContext = [
    Array.isArray(filters.project) && filters.project.length > 0 && `Projects: ${filters.project.join(', ')}`,
    Array.isArray(filters.state) && filters.state.length > 0 && `States: ${filters.state.join(', ')}`,
    Array.isArray(filters.area) && filters.area.length > 0 && `Areas: ${filters.area.join(', ')}`,
    Array.isArray(filters.workerName) && filters.workerName.length > 0 && `Workers: ${filters.workerName.join(', ')}`,
    (filters.dateFrom || filters.dateTo) && `Period: ${filters.dateFrom || 'start'} to ${filters.dateTo || 'end'}`,
  ].filter(Boolean).join(' | ')

  const languageNote = language ? `\n\n**Output Language:** Please write the entire response in ${language}.` : ''

  return `You are generating content for ${userName} from Jaljeevika, a rural development NGO.
${filterContext ? `Active Filters: ${filterContext}.` : ''}${truncatedNote}

**Your Task:**
${instruction || 'Write a comprehensive executive-style field work report with sections: Executive Summary, Field Observations, Analysis by Category, Impact & Beneficiaries, and Strategic Recommendations.'}

**Field Data Summary:**
- Total Activities: ${reports.length}
- Date Range: ${dateRange}
- Total Beneficiaries Reached: ${totalBeneficiaries.toLocaleString('en-IN')}
- Unique Projects: ${[...new Set(reports.map(r => r.project).filter(Boolean))].join(', ') || 'N/A'}
- States Covered: ${[...new Set(reports.map(r => r.state).filter(Boolean))].join(', ') || 'N/A'}

**Individual Activity Records:**
${activities}${languageNote}`
}

// ── Vite config ───────────────────────────────────────────────
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    base: '/',
    build: {
      rollupOptions: {
        output: {
          // React + Firebase are needed on every boot and change far less often
          // than app code — own chunks keep their hashes stable across deploys,
          // so returning users' browsers (assets are cached 1y immutable, see
          // server.js) re-download only the app code that actually changed.
          // tslib/idb are Firebase's own deps; grouping them in avoids a
          // circular import between this chunk and the entry chunk.
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
            if (/[\\/]node_modules[\\/](firebase|@firebase|tslib|idb)[\\/]/.test(id)) return 'vendor-firebase'
          },
        },
      },
    },
    plugins: [
      tailwindcss(),
      react(),

      // ── Gemini streaming middleware ──────────────────────────
      {
        name: 'report-api',
        configureServer(server) {

          // ── POST /api/auth/sheet-login ───────────────────────────
          server.middlewares.use('/api/auth/sheet-login', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            readBody(req).then(async body => {
              try {
                const { phone, password } = JSON.parse(body)
                if (!phone || !password) return jsonRes(res, 400, { error: 'phone and password required' })

                const normPhone = (p: string) => {
                  const c = String(p || '').replace(/\D/g, '')
                  if (c.length === 10) return '91' + c
                  if (c.length === 12 && c.startsWith('91')) return c
                  if (c.length > 12 && c.startsWith('9191')) return c.slice(2)
                  return c
                }
                const target = normPhone(phone)
                console.log('[sheet-login] raw phone:', phone, '→ target:', target)

                // Fetch users sheet
                const gToken = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON)
                if (!gToken) return jsonRes(res, 503, { error: 'Google service account not configured' })

                const sheetRes = await fetch(
                  `https://sheets.googleapis.com/v4/spreadsheets/${USERS_SHEET_ID}/values/${USERS_SHEET_NAME}!A:F`,
                  { headers: { Authorization: `Bearer ${gToken}` } }
                )
                const sheetData: any = await sheetRes.json()
                console.log('[sheet-login] sheet API response:', JSON.stringify(sheetData).slice(0, 500))
                const rows: string[][] = sheetData.values || []
                console.log('[sheet-login] row count:', rows.length, '| sheet phones:', rows.slice(1).map(r => `"${r[1]}"`).join(', '))
                const userRow = rows.slice(1).find(r => normPhone(r[1] || '') === target)
                if (!userRow) return jsonRes(res, 403, { error: 'Phone number not registered.' })

                const [name, , , role, , sheetPassword] = userRow
                if ((sheetPassword || '').trim() !== (password || '').trim()) {
                  return jsonRes(res, 403, { error: 'Incorrect password.' })
                }

                // Get orgId from DB
                ensureFirebase()
                const pool = getPool()
                const { rows: orgRows } = await pool.query(
                  'SELECT id FROM organizations WHERE slug = $1', ['jaljeevika']
                )
                const orgId = orgRows[0]?.id || ''

                // Create Firebase custom token with claims. Same uid format as the
                // real server (routes/auth.routes.js: sheet_<orgSlug>_<phone>) — the
                // old `sheet_<phone>` overwrote a live user's users.firebase_uid when
                // this dev server pointed at the shared DB, unlinking their session.
                const uid = `sheet_jaljeevika_${target}`
                const normRole = (role || 'employee').toLowerCase().trim()
                const customToken = await admin.auth().createCustomToken(uid, {
                  orgId, role: normRole, name, phone: target,
                })

                // Upsert user in DB (so /api/org/metadata works)
                await pool.query(
                  `INSERT INTO users (org_id, phone, name, role, firebase_uid)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (org_id, phone) DO UPDATE SET name=$3, role=$4, firebase_uid=$5`,
                  [orgId, target, name, normRole, uid]
                )

                jsonRes(res, 200, { customToken })
              } catch (e: any) {
                console.error('[sheet-login]', e)
                jsonRes(res, 500, { error: e.message || 'Login failed' })
              }
            })
          })

          // ── POST /api/auth/login ──────────────────────────────────
          server.middlewares.use('/api/auth/login', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            readBody(req).then(async () => {
              const decoded = await verifyToken(req)
              if (!decoded) return jsonRes(res, 401, { error: 'Invalid token' })
              try {
                const pool = getPool()
                const phone = (decoded.phone_number || '').replace(/[\s\-]/g, '').replace(/^\+/, '')
                let { rows } = await pool.query(
                  'SELECT u.id, u.org_id, u.name, u.role, o.metadata FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.firebase_uid = $1',
                  [decoded.uid]
                )
                if (!rows.length && phone) {
                  const byPhone = await pool.query(
                    'UPDATE users SET firebase_uid = $1 WHERE phone = $2 RETURNING id, org_id, name, role',
                    [decoded.uid, phone]
                  )
                  if (byPhone.rows.length) {
                    const u = byPhone.rows[0]
                    const orgRes = await pool.query('SELECT metadata FROM organizations WHERE id = $1', [u.org_id])
                    rows = [{ ...u, metadata: orgRes.rows[0]?.metadata }]
                  }
                }
                if (!rows.length) return jsonRes(res, 403, { error: 'User not registered. Contact your administrator.' })
                const { org_id: orgId, name, role, metadata } = rows[0]
                await admin.auth().setCustomUserClaims(decoded.uid, { orgId, role, name })
                jsonRes(res, 200, { success: true, orgId, metadata })
              } catch (e: any) {
                console.error('[auth/login ERROR]', e)
                jsonRes(res, 500, { error: e.message || 'Login failed' })
              }
            })
          })

          // ── GET /api/org/metadata ─────────────────────────────────
          server.middlewares.use('/api/org/metadata', (req: IncomingMessage, res, next) => {
            if (req.method !== 'GET') { next(); return }
            verifyToken(req).then(async decoded => {
              console.log('[org/metadata] decoded claims:', decoded ? JSON.stringify(decoded).slice(0, 300) : 'null')
              if (!decoded) return jsonRes(res, 401, { error: 'Invalid token' })
              const orgId = decoded.orgId as string
              if (!orgId) return jsonRes(res, 400, { error: 'No orgId in token claims' })
              try {
                const pool = getPool()
                const { rows } = await pool.query(
                  `SELECT o.id, o.slug, o.name, o.metadata,
                          o.subscription_status, o.subscription_expires_at,
                          o.billing_email, o.billing_notes,
                          p.id AS plan_id, p.name AS plan_name, p.slug AS plan_slug,
                          p.description AS plan_description, p.price_monthly, p.max_users,
                          p.ai_enabled, p.sort_order, p.is_active AS plan_is_active, to_jsonb(p)->'apps' AS plan_apps
                   FROM organizations o
                   LEFT JOIN plans p ON p.id = o.plan_id
                   WHERE o.id = $1`, [orgId]
                )
                if (!rows.length) return jsonRes(res, 404, { error: 'Organization not found' })
                const row = rows[0]
                const subscription = {
                  plan: row.plan_id ? {
                    id: row.plan_id, name: row.plan_name, slug: row.plan_slug,
                    description: row.plan_description,
                    price_monthly: Number(row.price_monthly),
                    max_users: row.max_users, ai_enabled: row.ai_enabled, apps: row.plan_apps ?? null,
                    sort_order: row.sort_order, is_active: row.plan_is_active,
                  } : null,
                  status:        row.subscription_status  || 'inactive',
                  expires_at:    row.subscription_expires_at ? row.subscription_expires_at.toISOString() : null,
                  billing_email: row.billing_email || '',
                  billing_notes: row.billing_notes || '',
                }
                jsonRes(res, 200, { orgId: row.id, slug: row.slug, name: row.name, metadata: stripSecretMeta(row.metadata), subscription })
              } catch (e: any) {
                jsonRes(res, 500, { error: e.message })
              }
            })
          })

          // ── GET /api/superadmin/orgs ──────────────────────────────
          server.middlewares.use('/api/superadmin/orgs', (req: IncomingMessage, res, next) => {
            if (req.method === 'GET') {
              verifyToken(req).then(async decoded => {
                if (!decoded) return jsonRes(res, 401, { error: 'Invalid token' })
                if (decoded.role !== 'superadmin') return jsonRes(res, 403, { error: 'Superadmin access required' })
                try {
                  const { rows } = await getPool().query('SELECT id, slug, name, metadata, created_at FROM organizations ORDER BY name')
                  jsonRes(res, 200, rows.map((r: any) => ({ ...r, metadata: maskSecretMeta(r.metadata) })))
                } catch { jsonRes(res, 500, { error: 'Internal server error' }) }
              })
            } else if (req.method === 'POST') {
              readBody(req).then(async body => {
                const decoded = await verifyToken(req)
                if (!decoded) return jsonRes(res, 401, { error: 'Invalid token' })
                if (decoded.role !== 'superadmin') return jsonRes(res, 403, { error: 'Superadmin access required' })
                try {
                  const { slug, name } = JSON.parse(body) || {}
                  if (!slug?.trim() || !name?.trim()) return jsonRes(res, 400, { error: 'slug and name are required' })
                  const { rows } = await getPool().query(
                    'INSERT INTO organizations (slug, name, metadata) VALUES ($1, $2, $3) RETURNING id, slug, name',
                    [slug.trim().toLowerCase(), name.trim(), JSON.stringify({ branding: { org_name: name.trim() } })]
                  )
                  jsonRes(res, 200, rows[0])
                } catch (e: any) {
                  const isDup = e.code === '23505'
                  jsonRes(res, isDup ? 409 : 500, { error: isDup ? 'slug already exists' : 'Internal server error' })
                }
              })
            } else { next() }
          })

          // ── PATCH /api/superadmin/org/:id/metadata ────────────────
          server.middlewares.use('/api/superadmin/org', (req: IncomingMessage, res, next) => {
            if (req.method !== 'PATCH') { next(); return }
            const match = req.url?.match(/^\/([^/]+)\/metadata$/)
            if (!match) { next(); return }
            const id = match[1]
            readBody(req).then(async body => {
              const decoded = await verifyToken(req)
              if (!decoded) return jsonRes(res, 401, { error: 'Invalid token' })
              if (decoded.role !== 'superadmin') return jsonRes(res, 403, { error: 'Superadmin access required' })
              try {
                const patch = JSON.parse(body)
                // Same allowlist as routes/superadmin.routes.js — dev must not be laxer than prod.
                const ALLOWED = new Set(['branding', 'modules', 'ai_config', 'data_sources', 'features', 'contentHubPermissions', 'tabPermissions', 'glific_webhook_secret', 'glific_org_code', 'subscription_notes'])
                if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return jsonRes(res, 400, { error: 'Request body must be a JSON object' })
                const unknown = Object.keys(patch).filter(k => !ALLOWED.has(k))
                if (unknown.length) return jsonRes(res, 400, { error: `Unknown metadata keys: ${unknown.join(', ')}` })
                const { rows } = await getPool().query(
                  'UPDATE organizations SET metadata = metadata || $1::jsonb WHERE id = $2 RETURNING id, metadata',
                  [JSON.stringify(prepareSecretPatch(patch)), id]
                )
                if (!rows.length) return jsonRes(res, 404, { error: 'Organization not found' })
                jsonRes(res, 200, { id: rows[0].id, metadata: maskSecretMeta(rows[0].metadata) })
              } catch { jsonRes(res, 500, { error: 'Internal server error' }) }
            })
          })

          // ── Send OTP API ──────────────────────────────────────────
          server.middlewares.use('/api/send-otp', (req: IncomingMessage, res) => {
            if (req.method !== 'POST') { res.end(); return }

            let body = ''
            req.on('data', chunk => { body += chunk })
            req.on('end', async () => {
              const { phone, otp, channel } = JSON.parse(body)
              console.log(`[AUTH] Sending OTP ${otp} to ${phone} via ${channel}`)

              let success = false
              let error   = null

              // ── Option 1: Twilio SMS (if configured) ─────────
              if (env.TWILIO_SID && env.TWILIO_TOKEN && channel === 'sms') {
                try {
                  const auth = Buffer.from(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`).toString('base64')
                  const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
                    method: 'POST',
                    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                      From: env.TWILIO_PHONE || '',
                      To:   phone.startsWith('+') ? phone : `+${phone}`,
                      Body: `Your FieldFlow verification code is: ${otp}. Do not share this with anyone.`,
                    }),
                  })
                  if (twRes.ok) success = true
                  else error = await twRes.text()
                } catch (e) { error = String(e) }
              } 
              // ── Option 1b: Twilio WhatsApp (if configured) ─────
              else if (env.TWILIO_SID && env.TWILIO_TOKEN && channel === 'whatsapp') {
                try {
                  const auth = Buffer.from(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`).toString('base64')
                  const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
                    method: 'POST',
                    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                      From: `whatsapp:${(env.TWILIO_WHATSAPP || '').replace('whatsapp:', '')}`,
                      To:   `whatsapp:${phone.startsWith('+') ? phone : `+${phone}`}`,
                      Body: `Your FieldFlow verification code is: ${otp}. Do not share this with anyone.`,
                    }),
                  })
                  if (twRes.ok) success = true
                  else error = await twRes.text()
                } catch (e) { error = String(e) }
              }
              // ── Option 2: Fast2SMS (if configured) ─────────
              else if (env.FAST2SMS_KEY && channel === 'sms') {
                try {
                  const f2Res = await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${env.FAST2SMS_KEY}&route=otp&variables_values=${otp}&numbers=${phone.replace(/\+/g, '')}`)
                  if (f2Res.ok) success = true
                  else error = await f2Res.text()
                } catch (e) { error = String(e) }
              }
              // ── Fallback: Simulation ───────────────────────
              else {
                success = true // Fake success for demo
              }

              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ success, error }))
            })
          })

          server.middlewares.use('/api/get-ai-report', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }

            res.statusCode = 200
            res.setHeader('Content-Type',                'text/event-stream')
            res.setHeader('Cache-Control',               'no-cache, no-transform')
            res.setHeader('Connection',                  'keep-alive')
            res.setHeader('X-Accel-Buffering',           'no')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.flushHeaders()

            const flush = () => (res as unknown as { flush?: () => void }).flush?.()
            const send = (payload: Record<string, unknown>) => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`)
              flush()
            }

            let body = ''
            req.on('data', (chunk: Buffer) => { body += chunk.toString() })
            req.on('end', async () => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey || apiKey === 'your_gemini_api_key_here') {
                  send({ error: 'Set GEMINI_API_KEY in .env' })
                  res.end(); return
                }

                const { reports, userName, filters, instruction, language } = JSON.parse(body) as {
                  reports:  Record<string, unknown>[]
                  userName: string
                  filters:  Record<string, unknown>
                  instruction?: string
                  audience?: string
                  language?: string
                }

                send({ text: '⚙️ *Initializing Gemini connection...*\n\n' })

                const geminiRes = await fetch(GEMINI_URL(apiKey), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                  body: JSON.stringify({
                    contents: [{
                      role: 'user',
                      parts: [{
                        text: buildReportPrompt(userName, reports, filters, instruction, language),
                      }],
                    }],
                    systemInstruction: {
                      parts: [{
                        text: 'You are an expert field work analyst for a rural development NGO. Write clear, insightful reports that highlight impact and provide actionable recommendations. Always respond in well-structured Markdown.',
                      }],
                    },
                    generationConfig: {
                      maxOutputTokens: 8192,
                      temperature:     0.7,
                    },
                  }),
                })

                if (!geminiRes.ok || !geminiRes.body) {
                  const errText = await geminiRes.text()
                  let hint = ''
                  if (geminiRes.status === 400) hint = '\n\n**Hint:** Check model name or request format.'
                  if (geminiRes.status === 403) hint = '\n\n**Hint:** API key may be invalid, expired, or lacks Gemini API access.'
                  if (geminiRes.status === 429) hint = '\n\n**Hint:** Rate limit hit — wait a minute and try again.'
                  if (geminiRes.status === 404) hint = '\n\n**Hint:** Model not found. The model name may be incorrect or not available in your region.'
                  send({ text: `### Gemini API Error (${geminiRes.status})\n\n\`\`\`\n${errText.slice(0, 800)}\n\`\`\`${hint}` })
                  res.end(); return
                }

                send({ text: '📝 *Analysing records...*\n\n' })

                const reader  = geminiRes.body.getReader()
                const decoder = new TextDecoder()
                let   buffer  = ''

                try {
                  while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    
                    buffer += decoder.decode(value, { stream: true })
                    // Process lines in buffer
                    const lines = buffer.split('\n')
                    buffer = lines.pop() ?? ''

                    for (const line of lines) {
                      const trimmed = line.trim()
                      if (!trimmed || !trimmed.startsWith('data: ')) continue
                      
                      const raw = trimmed.slice(6).trim()
                      if (!raw || raw === '[DONE]') continue
                      
                      try {
                        const chunk = JSON.parse(raw)
                        const candidates = chunk?.candidates || chunk?.result?.candidates
                        const text = candidates?.[0]?.content?.parts?.[0]?.text
                        if (text) send({ text })
                      } catch (e) {
                        // skip invalid JSON
                      }
                    }
                  }
                  
                  // Final flush
                  if (buffer.startsWith('data: ')) {
                    const raw = buffer.slice(6).trim()
                    try {
                       const chunk = JSON.parse(raw)
                       const candidates = chunk?.candidates || chunk?.result?.candidates
                       const text = candidates?.[0]?.content?.parts?.[0]?.text
                       if (text) send({ text })
                    } catch {}
                  }

                } catch (e) {
                  send({ error: `Stream Error: ${e instanceof Error ? e.message : 'Unknown'}` })
                } finally {
                  res.write('data: [DONE]\n\n')
                  res.end()
                }

              } catch (e) {
                send({ error: e instanceof Error ? e.message : 'Unknown error' })
                res.end()
              }
            })
          })

          // ── Image Proxy (bypass CORS for Drive thumbnails) ──────────
          server.middlewares.use('/api/proxy-image', (req: IncomingMessage, res, next) => {
            if (req.method !== 'GET') { next(); return }
            const rawUrl = new URL(req.url || '', 'http://localhost').searchParams.get('url')
            if (!rawUrl) { res.statusCode = 400; res.end('Missing url'); return }
            ;(async () => {
              try {
                const imgRes = await fetch(rawUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
                if (!imgRes.ok) { res.statusCode = imgRes.status; res.end(); return }
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg'
                res.setHeader('Content-Type', contentType)
                res.setHeader('Cache-Control', 'public, max-age=3600')
                const buffer = await imgRes.arrayBuffer()
                res.end(Buffer.from(buffer))
              } catch {
                res.statusCode = 500; res.end('Failed to fetch image')
              }
            })()
          })

          // ── Drive Folder Listing ─────────────────────────────────
          server.middlewares.use('/api/drive-folder', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }

            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')

            let body = ''
            req.on('data', (chunk: Buffer) => { body += chunk.toString() })
            req.on('end', async () => {
              try {
                const apiKey = (env.GOOGLE_DRIVE_API_KEY || env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) {
                  res.end(JSON.stringify({
                    error: 'Set GEMINI_API_KEY (or GOOGLE_DRIVE_API_KEY) in .env',
                  }))
                  return
                }

                const { folderId } = JSON.parse(body) as { folderId: string }
                if (!folderId) {
                  res.end(JSON.stringify({ error: 'folderId is required' }))
                  return
                }

                // List image/video files in the folder
                const q   = encodeURIComponent(`'${folderId}' in parents and (mimeType contains 'image/' or mimeType contains 'video/')`)
                const url = `https://www.googleapis.com/drive/v3/files?q=${q}&key=${apiKey}&fields=files(id,name,mimeType,createdTime,thumbnailLink)&pageSize=200&orderBy=createdTime+desc`

                const driveRes = await fetch(url)
                const data: any = await driveRes.json()

                if (!driveRes.ok || data.error) {
                  // Surface a friendly hint if Drive API isn't enabled
                  const reason = data?.error?.details?.[0]?.reason || ''
                  if (reason === 'API_KEY_SERVICE_BLOCKED' || data?.error?.code === 403) {
                    res.end(JSON.stringify({
                      error: 'Google Drive API is not enabled on this API key.\n\n' +
                             'Enable it at:\nhttps://console.cloud.google.com/apis/library/drive.googleapis.com\n\n' +
                             'Then click "Enable" for the same project as your Gemini key.',
                    }))
                    return
                  }
                  res.end(JSON.stringify({
                    error: data?.error?.message || `Drive API error ${driveRes.status}`,
                  }))
                  return
                }

                // Normalise the response
                const files = (data.files || []).map((f: any) => ({
                  id:        f.id,
                  name:      f.name,
                  mimeType:  f.mimeType,
                  createdTime: f.createdTime,
                  thumb:     `https://drive.google.com/thumbnail?id=${f.id}&sz=w800`,
                  full:      `https://lh3.googleusercontent.com/d/${f.id}`,
                  drive:     `https://drive.google.com/file/d/${f.id}/view`,
                }))

                res.end(JSON.stringify({ files }))

              } catch (e) {
                res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Unknown error' }))
              }
            })
          })

          // ── User Management (add / update / delete) ─────────────
          server.middlewares.use('/api/add-user', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            let body = ''
            req.on('data', (c: Buffer) => { body += c.toString() })
            req.on('end', async () => {
              const { name, phone, state, role, manager, password } = JSON.parse(body || '{}')
              if (!name?.trim() || !phone?.trim() || !role?.trim()) {
                res.statusCode = 400; res.end(JSON.stringify({ error: 'Name, phone and role are required.' })); return
              }
              const token = await getGoogleAccessToken((env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim())
              if (!token) {
                res.statusCode = 503; res.end(JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set in .env' })); return
              }
              const row = [name.trim(), normPhone(phone), (state||'').trim(), role.trim(), (manager||'').trim(), (password||'').trim()]
              const ar = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${USERS_SHEET_ID}/values/${USERS_SHEET_NAME}!A:F:append?valueInputOption=USER_ENTERED`,
                { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) }
              )
              if (!ar.ok) { res.statusCode = 500; res.end(JSON.stringify({ error: await ar.text() })); return }
              res.end(JSON.stringify({ success: true }))
            })
          })

          server.middlewares.use('/api/update-user', (req: IncomingMessage, res, next) => {
            if (req.method !== 'PUT') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            let body = ''
            req.on('data', (c: Buffer) => { body += c.toString() })
            req.on('end', async () => {
              const { originalPhone, name, phone, state, role, manager, password } = JSON.parse(body || '{}')
              if (!originalPhone?.trim() || !name?.trim() || !phone?.trim() || !role?.trim()) {
                res.statusCode = 400; res.end(JSON.stringify({ error: 'originalPhone, name, phone and role are required.' })); return
              }
              const token = await getGoogleAccessToken((env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim())
              if (!token) {
                res.statusCode = 503; res.end(JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set in .env' })); return
              }
              const rowIdx = await findUserRowIndex(token, originalPhone)
              if (rowIdx < 0) { res.statusCode = 404; res.end(JSON.stringify({ error: 'User not found in sheet.' })); return }
              const row = [name.trim(), normPhone(phone), (state||'').trim(), role.trim(), (manager||'').trim(), (password||'').trim()]
              const ur = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${USERS_SHEET_ID}/values/${USERS_SHEET_NAME}!A${rowIdx}:F${rowIdx}?valueInputOption=USER_ENTERED`,
                { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) }
              )
              if (!ur.ok) { res.statusCode = 500; res.end(JSON.stringify({ error: await ur.text() })); return }
              res.end(JSON.stringify({ success: true }))
            })
          })

          server.middlewares.use('/api/delete-user', (req: IncomingMessage, res, next) => {
            if (req.method !== 'DELETE') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            let body = ''
            req.on('data', (c: Buffer) => { body += c.toString() })
            req.on('end', async () => {
              const { phone } = JSON.parse(body || '{}')
              if (!phone?.trim()) { res.statusCode = 400; res.end(JSON.stringify({ error: 'phone is required.' })); return }
              const token = await getGoogleAccessToken((env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim())
              if (!token) {
                res.statusCode = 503; res.end(JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not set in .env' })); return
              }
              const rowIdx = await findUserRowIndex(token, phone)
              if (rowIdx < 0) { res.statusCode = 404; res.end(JSON.stringify({ error: 'User not found in sheet.' })); return }
              const dr = await fetch(
                `https://sheets.googleapis.com/v4/spreadsheets/${USERS_SHEET_ID}:batchUpdate`,
                {
                  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIdx - 1, endIndex: rowIdx } } }] }),
                }
              )
              if (!dr.ok) { res.statusCode = 500; res.end(JSON.stringify({ error: await dr.text() })); return }
              res.end(JSON.stringify({ success: true }))
            })
          })

          // ── Social Media Post Generation ─────────────────────────
          server.middlewares.use('/api/generate-social-post', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }

            res.statusCode = 200
            res.setHeader('Content-Type',                'text/event-stream')
            res.setHeader('Cache-Control',               'no-cache, no-transform')
            res.setHeader('Connection',                  'keep-alive')
            res.setHeader('X-Accel-Buffering',           'no')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.flushHeaders()

            const flush = () => (res as unknown as { flush?: () => void }).flush?.()
            const send  = (payload: Record<string, unknown>) => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`)
              flush()
            }

            let body = ''
            req.on('data', (chunk: Buffer) => { body += chunk.toString() })
            req.on('end', async () => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey || apiKey === 'your_gemini_api_key_here') {
                  send({ error: 'Set GEMINI_API_KEY in .env' })
                  res.end(); return
                }

                const { reports, platform, tone, scope, scopeName, language } = JSON.parse(body) as {
                  reports:   Record<string, unknown>[]
                  platform:  'instagram' | 'facebook' | 'twitter' | 'linkedin'
                  tone:      'inspiring' | 'celebratory' | 'professional' | 'urgent'
                  scope:     'project' | 'organization'
                  scopeName: string
                  language?: string
                }

                // Compute summary stats
                const totalBenef = reports.reduce((s, r) => {
                  const n = parseInt(String(r.beneficiaries ?? 0)) || 0
                  return s + n
                }, 0)
                const states   = [...new Set(reports.map(r => r.state).filter(Boolean))]
                const projects = [...new Set(reports.map(r => r.project).filter(Boolean))]
                const areas    = [...new Set(reports.map(r => r.areaOfIntervention).filter(Boolean))]

                // Pick highlight activities (with attachments for visual posts)
                const highlights = reports
                  .filter(r => r.attachmentUrl)
                  .slice(0, 8)
                  .map((r, i) => `${i + 1}. ${r.location}, ${r.state} — ${String(r.description).slice(0, 200)}`)
                  .join('\n')

                const platformGuide: Record<string, string> = {
                  instagram: `
- STRUCTURE: Hook (first line) -> Context -> Transformation -> Call to Action -> 15-20 hashtags.
- FORMAT: Use 3-5 short, airy paragraphs.
- TONE: Visually engaging, enthusiastic, and community-centric.
- EMOJIS: Use emojis generously to separate sections and add personality.
- CAPTION LIMIT: Max 2200 characters.`,
                  facebook: `
- STRUCTURE: Story Opening -> The "Jaljeevika Moment" -> Call to Action -> 5-8 hashtags.
- FORMAT: Narrative/blog-style (2-3 paragraphs). Conversational and warm.
- TONE: Personal, accessible, and inclusive.
- EMOJIS: Sparse and natural.
- AUDIENCE: Local communities, families, and long-term supporters.`,
                  twitter: `
- STRUCTURE: Impact Headline -> Short Context -> Link/Call to Action -> 2-3 hashtags.
- FORMAT: Maximum 280 characters. Consider a 2-tweet thread if the story is complex.
- TONE: Punchy, immediate, and news-oriented.
- EMOJIS: 1-2 strategic emojis.`,
                  linkedin: `
- STRUCTURE: Professional Hook (Insight or Stat) -> Impact Analysis -> Strategic Takeaway -> 5 professional hashtags.
- FORMAT: 3-4 blocks of text with double line breaks for mobile readability.
- TONE: Thought-leadership, data-driven, and authoritative.
- EMOJIS: Maximum 1-2 professional icons.`,
                }

                const toneGuide: Record<string, string> = {
                  inspiring:    'Focus on human transformation, hope, and the ripple effect of empowerment.',
                  celebratory:  'Highlight milestones, growth, and the joy of collective achievement.',
                  professional: 'Focus on ROI, evidence-based results, and strategic alignment for donors/partners.',
                  urgent:       'Emphasize the immediate need, the "why now," and a strong call to action.',
                }

                const prompt = `
ROLE: You are the Senior Communications Director and Impact Storyteller for Jaljeevika (an NGO focused on inland fisheries and rural water stewardship).

CONTEXT: You are looking at a batch of raw field reports from our staff. You need to convert this data into an engaging social media post for ${scope === 'organization' ? 'our entire organization' : `the "${scopeName}" project`}.

TASK: Create a ${platform}-ready post in a ${tone} tone.

PLATFORM-SPECIFIC RULES:
${platformGuide[platform]}

TONE FOCUS:
${toneGuide[tone]}

FIELD INTELLIGENCE (DATA POINTS):
- Total field reports analyzed: ${reports.length}
- Beneficiaries impacted: ${totalBenef.toLocaleString('en-IN')}
- Geographic footprint: ${states.length} States (${states.slice(0, 5).join(', ')})
- Key projects involved: ${projects.slice(0, 5).join(', ')}
- Primary interventions: ${areas.slice(0, 5).join(', ')}

STORY MATERIAL (ACTUAL FIELD ACTIVITIES):
${highlights || reports.slice(0, 8).map((r, i) => `${i + 1}. [${r.location}, ${r.state}] ${String(r.description).slice(0, 200)}`).join('\n')}

INSTRUCTIONS:
1. START WITH A HOOK: Use a powerful statistic or a short, moving human detail from the field activities.
2. HUMAN-CENTRIC: Even when citing numbers, explain the "human value" behind them.
3. BE SPECIFIC: Mention locations if they add flavor, but keep the focus on the outcome.
4. CALL TO ACTION: End with a clear next step (e.g., "Follow our journey," "Support our work," or "Share if you believe in water security").
5. PHOTO REFERENCE: Mention the "photos from the field" that will accompany this post.
6. NO ROBOT-SPEAK: Do not use phrases like "In conclusion," "Firstly," or "This post highlights." Speak like a person who was there.

${language ? `OUTPUT LANGUAGE: All text (including hashtags) MUST be in ${language}.` : ''}

OUTPUT: Only provide the post content. No pre-post commentary.`

                const geminiRes = await fetch(GEMINI_URL(apiKey), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                  body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    systemInstruction: {
                      parts: [{
                        text: 'You are a master of social media engagement for NGOs. You specialize in "impact transparency" — making data feel human and making donors feel like heroes. Avoid clichés. Use active verbs. Ensure the structure is perfect for the selected platform.',
                      }],
                    },
                    generationConfig: {
                      maxOutputTokens: 2048,
                      temperature:     0.85,
                    },
                  }),
                })

                if (!geminiRes.ok || !geminiRes.body) {
                  const errText = await geminiRes.text()
                  send({ error: `Gemini error ${geminiRes.status}: ${errText.slice(0, 300)}` })
                  res.end(); return
                }

                const reader  = geminiRes.body.getReader()
                const decoder = new TextDecoder()
                let   buffer  = ''

                try {
                  while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    buffer += decoder.decode(value, { stream: true })
                    const lines = buffer.split('\n')
                    buffer = lines.pop() ?? ''

                    for (const line of lines) {
                      const trimmed = line.trim()
                      if (!trimmed.startsWith('data: ')) continue
                      const raw = trimmed.slice(6).trim()
                      if (!raw || raw === '[DONE]') continue
                      try {
                        const chunk = JSON.parse(raw)
                        const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
                        if (text) send({ text })
                      } catch { /* skip */ }
                    }
                  }
                  if (buffer.startsWith('data: ')) {
                    const raw = buffer.slice(6).trim()
                    try {
                      const chunk = JSON.parse(raw)
                      const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
                      if (text) send({ text })
                    } catch {}
                  }
                } catch (e) {
                  send({ error: `Stream error: ${e instanceof Error ? e.message : 'Unknown'}` })
                } finally {
                  res.write('data: [DONE]\n\n')
                  res.end()
                }

              } catch (e) {
                send({ error: e instanceof Error ? e.message : 'Unknown error' })
                res.end()
              }
            })
          })
          // ════════════════════════════════════════════════════════
          // ── NOTEBOOK API ROUTES ────────────────────────────────
          // ════════════════════════════════════════════════════════

          // ── Helper: build Gemini SSE request ──────────────────
          async function callGeminiSSE(
            apiKey: string,
            prompt: string,
            systemPrompt: string,
            res: any,
            maxTokens = 4096,
            temperature = 0.7
          ) {
            const send = (payload: Record<string, unknown>) => {
              res.write(`data: ${JSON.stringify(payload)}\n\n`)
              ;(res as any).flush?.()
            }

            const geminiRes = await fetch(GEMINI_URL(apiKey), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { maxOutputTokens: maxTokens, temperature },
              }),
            })

            if (!geminiRes.ok || !geminiRes.body) {
              send({ error: `Gemini error ${geminiRes.status}` })
              res.end(); return
            }

            const reader  = geminiRes.body.getReader()
            const decoder = new TextDecoder()
            let   buffer  = ''

            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed.startsWith('data: ')) continue
                  const raw = trimmed.slice(6).trim()
                  if (!raw || raw === '[DONE]') continue
                  try {
                    const chunk = JSON.parse(raw)
                    const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
                    if (text) send({ text })
                  } catch { /* skip */ }
                }
              }
              if (buffer.startsWith('data: ')) {
                try {
                  const chunk = JSON.parse(buffer.slice(6).trim())
                  const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
                  if (text) send({ text })
                } catch { /* skip */ }
              }
            } finally {
              res.write('data: [DONE]\n\n')
              res.end()
            }
          }

          function setupNotebookSSE(res: any) {
            res.statusCode = 200
            res.setHeader('Content-Type',                'text/event-stream')
            res.setHeader('Cache-Control',               'no-cache, no-transform')
            res.setHeader('Connection',                  'keep-alive')
            res.setHeader('X-Accel-Buffering',           'no')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.flushHeaders()
          }


          // ── POST /api/notebook/upload ─────────────────────────
          server.middlewares.use('/api/notebook/upload', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            readBody(req).then(async body => {
              try {
                const { name, type, dataBase64 } = JSON.parse(body)
                const buf = Buffer.from(dataBase64, 'base64')

                if (type === 'pdf') {
                  const { PDFParse } = await import('pdf-parse') as any
                  const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: 0 })
                  const result = await parser.getText()
                  const content = (result.text as string).slice(0, 200_000)
                  res.end(JSON.stringify({
                    id: Math.random().toString(36).slice(2),
                    name, type: 'pdf', content, charCount: content.length,
                  }))
                } else {
                  const content = buf.toString('utf-8').slice(0, 200_000)
                  res.end(JSON.stringify({
                    id: Math.random().toString(36).slice(2),
                    name, type: 'txt', content, charCount: content.length,
                  }))
                }
              } catch (e) {
                res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Upload failed' }))
              }
            })
          })

          // ── POST /api/notebook/fetch-url ──────────────────────
          server.middlewares.use('/api/notebook/fetch-url', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            readBody(req).then(async body => {
              try {
                const { url } = JSON.parse(body)
                if (!url) { res.end(JSON.stringify({ error: 'url is required' })); return }

                const pageRes = await fetch(url, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NotebookBot/1.0)' },
                  signal: AbortSignal.timeout(15_000),
                })
                if (!pageRes.ok) { res.end(JSON.stringify({ error: `HTTP ${pageRes.status}` })); return }

                const html = await pageRes.text()
                // Strip scripts, styles, tags
                const text = html
                  .replace(/<script[\s\S]*?<\/script>/gi, '')
                  .replace(/<style[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/&nbsp;/g, ' ')
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/\s{2,}/g, ' ')
                  .trim()
                  .slice(0, 100_000)

                const hostname = new URL(url).hostname
                res.end(JSON.stringify({
                  id: Math.random().toString(36).slice(2),
                  name: hostname,
                  type: 'url',
                  content: text,
                  charCount: text.length,
                }))
              } catch (e) {
                res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Fetch failed' }))
              }
            })
          })

          // ── POST /api/notebook/chat (SSE) ─────────────────────
          server.middlewares.use('/api/notebook/chat', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, message, history } = JSON.parse(body)
                const srcBlock = (sources as any[]).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${s.content}\n---`
                ).join('\n\n')
                const histBlock = (history as any[] || []).slice(-6).map((m: any) =>
                  `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`
                ).join('\n')
                const prompt = `Sources:\n${srcBlock}\n\n${histBlock ? `Conversation so far:\n${histBlock}\n\n` : ''}User: ${message}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a research assistant. Answer ONLY using the provided sources. When you use information from a source, cite it as [Source: name]. Be concise and accurate.',
                  res, 2048, 0.6
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/notebook/audio (SSE) ────────────────────
          server.middlewares.use('/api/notebook/audio', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, languageCode = 'en-IN', languageLabel = 'English (India)', host1Name = 'Alex', host2Name = 'Jordan' } = JSON.parse(body)
                const srcBlock = (sources as any[]).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${s.content}\n---`
                ).join('\n\n')
                const langInstruction = languageCode === 'en-IN'
                  ? 'Write the entire script in Indian English.'
                  : `Write the entire script in ${languageLabel} (language code: ${languageCode}). Use the natural spoken form of the language.`
                const prompt = `Based on these sources, create a ~5-minute engaging podcast script between two hosts: Host 1 is named "${host1Name}" (thoughtful, asks probing questions) and Host 2 is named "${host2Name}" (knowledgeable, gives clear explanations). Inside the dialogue, the hosts must address each other by their names "${host1Name}" and "${host2Name}". Format every line with the prefix "ALEX: " for ${host1Name} and "JORDAN: " for ${host2Name} — these prefixes are only parsing markers, not names spoken aloud. Cover key insights, surprising findings, and practical takeaways. Start immediately with the script. ${langInstruction}\n\nSources:\n${srcBlock}`
                await callGeminiSSE(
                  apiKey, prompt,
                  `You are a podcast script writer. Create natural, engaging dialogue. Every line MUST start with "ALEX: " (for host ${host1Name}) or "JORDAN: " (for host ${host2Name}). Hosts call each other by their names "${host1Name}" and "${host2Name}" within the dialogue. No stage directions, no other formatting. Write exclusively in ${languageLabel}.`,
                  res, 4096, 0.85
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/notebook/tts ────────────────────────────
          server.middlewares.use('/api/notebook/tts', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'GEMINI_API_KEY not set' })); return }
                const { text, voice = 'Charon', languageCode = 'en-IN' } = JSON.parse(body)
                if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'text is required' })); return }

                const ttsUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`
                const geminiRes = await fetch(ttsUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [{ parts: [{ text }] }],
                    generationConfig: {
                      responseModalities: ['AUDIO'],
                      speechConfig: {
                        languageCode,
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
                      },
                    },
                  }),
                })
                const data: any = await geminiRes.json()
                const part      = data?.candidates?.[0]?.content?.parts?.[0]
                const audioData = part?.inlineData?.data
                const mimeType  = part?.inlineData?.mimeType || 'audio/pcm;rate=24000'
                if (!audioData) {
                  const errMsg = data?.error?.message || 'No audio returned from Gemini TTS'
                  res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: errMsg })); return
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ audioData, mimeType }))
              } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'TTS failed' }))
              }
            })
          })

          // ── POST /api/notebook/study-guide (SSE) ─────────────
          server.middlewares.use('/api/notebook/study-guide', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, format } = JSON.parse(body)
                const srcBlock = (sources as any[]).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${s.content}\n---`
                ).join('\n\n')
                const formatPrompts: Record<string, string> = {
                  summary:  'Write a comprehensive executive summary with key themes, main findings, and important conclusions. Use ## headings and bullet points.',
                  faq:      'Generate the top 10 most important questions and detailed answers about the content. Format as ## Q: ... then **A:** ...',
                  timeline: 'Extract and list all chronological events, developments, or steps mentioned. Format as a numbered timeline with dates/phases where available.',
                  briefing: 'Write a concise one-page briefing document with: Context, Key Points (bullets), Implications, and Recommended Actions.',
                }
                const prompt = `${formatPrompts[format] || formatPrompts.summary}\n\nSources:\n${srcBlock}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a research analyst. Create clear, well-structured study materials in Markdown. Be thorough but concise.',
                  res, 3072, 0.65
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/notebook/slide-deck (SSE) ──────────────
          server.middlewares.use('/api/notebook/slide-deck', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, mode = 'detailed', customPrompt = '' } = JSON.parse(body)
                const srcBlock = (sources as any[]).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${s.content}\n---`
                ).join('\n\n')
                const modeInstructions = mode === 'presenter'
                  ? 'Each slide: 3-4 concise bullet points (max 12 words each), 1-sentence speaker note. Minimal text, visual-first.'
                  : 'Each slide: 5-6 detailed bullet points, comprehensive 2-3 sentence speaker notes with supporting detail.'
                const prompt = `Create a 10-slide presentation from these sources. Return ONLY a valid JSON array (no markdown, no explanation) with exactly this structure:
[
  {
    "title": "Slide title",
    "bullets": ["Point 1", "Point 2", "Point 3"],
    "speakerNotes": "What the presenter should say"
  }
]

Mode: ${mode === 'presenter' ? 'Presenter Slides' : 'Detailed Deck'}. ${modeInstructions}
The first slide should be a title/overview slide. Last slide should be conclusions/next steps. Make it compelling and data-driven.
${customPrompt ? `\nAdditional instructions: ${customPrompt}` : ''}

Sources:\n${srcBlock}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a presentation designer. Return ONLY valid JSON — no markdown code fences, no explanation text, just the raw JSON array. Never use literal newline characters inside JSON string values.',
                  res, 8192, 0.6
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/notebook/slide-revise (SSE) ────────────
          server.middlewares.use('/api/notebook/slide-revise', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, slide, instruction, index, total } = JSON.parse(body)
                const srcBlock = (sources as any[]).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${s.content.slice(0, 20000)}\n---`
                ).join('\n\n')
                const prompt = `You are revising slide ${index + 1} of ${total} in a presentation.

Current slide:
Title: ${slide.title}
Bullets: ${(slide.bullets as string[]).join(' | ')}
Speaker Notes: ${slide.speakerNotes}

Revision instruction: "${instruction}"

Return ONLY a single valid JSON object (no array, no markdown fences):
{
  "title": "...",
  "bullets": ["...", "..."],
  "speakerNotes": "..."
}

Sources:\n${srcBlock}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a presentation designer. Return ONLY a single valid JSON object — no array, no markdown fences, no explanation. Never use literal newline characters inside JSON string values.',
                  res, 2048, 0.6
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })
          // ═══════════════════════════════════════════════════════════════════
          // REPORT WRITER API ROUTES  (/api/rw/*)
          // ═══════════════════════════════════════════════════════════════════

          const rwSheetId = (env.RW_SHEET_ID || '').trim()

          async function rwGetToken(): Promise<string | null> {
            return getGoogleAccessToken((env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim())
          }

          async function rwReadTab(token: string, tabName: string, range: string): Promise<string[][]> {
            if (!rwSheetId) return []
            const r = await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${rwSheetId}/values/${encodeURIComponent(tabName)}!${range}`,
              { headers: { Authorization: `Bearer ${token}` } }
            )
            const d: any = await r.json()
            return d.values || []
          }

          async function rwAppendRow(token: string, tabName: string, values: string[]): Promise<void> {
            if (!rwSheetId) return
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${rwSheetId}/values/${encodeURIComponent(tabName)}!A:Z:append?valueInputOption=USER_ENTERED`,
              { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) }
            )
          }

          async function rwUpdateRow(token: string, tabName: string, rowIdx: number, values: string[]): Promise<void> {
            if (!rwSheetId) return
            await fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${rwSheetId}/values/${encodeURIComponent(tabName)}!A${rowIdx}:Z${rowIdx}?valueInputOption=USER_ENTERED`,
              { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) }
            )
          }

          async function rwFindRow(token: string, tabName: string, colIndex: number, value: string): Promise<number> {
            const rows = await rwReadTab(token, tabName, 'A:Z')
            for (let i = 1; i < rows.length; i++) {
              if (String(rows[i][colIndex] || '').trim() === String(value).trim()) return i + 1
            }
            return -1
          }

          // ── GET /api/rw/profile ────────────────────────────────────────────
          server.middlewares.use('/api/rw/profile', (req: IncomingMessage, res, next) => {
            if (req.method !== 'GET') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            const url = new URL(req.url || '', 'http://localhost')
            const contributor = url.searchParams.get('contributor') || ''
            if (!contributor) { res.end(JSON.stringify({ profile: null })); return }
            rwGetToken().then(async token => {
              try {
                if (!token || !rwSheetId) { res.end(JSON.stringify({ profile: null })); return }
                const rowIdx = await rwFindRow(token, 'rw_profiles', 0, contributor)
                if (rowIdx < 0) { res.end(JSON.stringify({ profile: null })); return }
                const rows = await rwReadTab(token, 'rw_profiles', `A${rowIdx}:D${rowIdx}`)
                const row = rows[0] || []
                const profile = row[2] ? JSON.parse(row[2]) : null
                res.end(JSON.stringify({ profile }))
              } catch { res.end(JSON.stringify({ profile: null })) }
            })
          })

          // ── POST /api/rw/profile/save ──────────────────────────────────────
          server.middlewares.use('/api/rw/profile/save', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            readBody(req).then(async body => {
              try {
                const { profile } = JSON.parse(body)
                if (!profile?.id) { res.statusCode = 400; res.end(JSON.stringify({ error: 'profile.id required' })); return }
                const token = await rwGetToken()
                if (!token || !rwSheetId) { res.statusCode = 503; res.end(JSON.stringify({ error: 'RW_SHEET_ID or service account not configured' })); return }
                const rowIdx = await rwFindRow(token, 'rw_profiles', 0, profile.id)
                const row = [profile.id, profile.contributorName, JSON.stringify(profile), new Date().toISOString()]
                if (rowIdx < 0) await rwAppendRow(token, 'rw_profiles', row)
                else await rwUpdateRow(token, 'rw_profiles', rowIdx, row)
                res.end(JSON.stringify({ success: true }))
              } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Error' })) }
            })
          })

          // ── GET /api/rw/glossary ───────────────────────────────────────────
          server.middlewares.use('/api/rw/glossary', (req: IncomingMessage, res, next) => {
            if (req.method !== 'GET') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            rwGetToken().then(async token => {
              try {
                if (!token || !rwSheetId) { res.end(JSON.stringify({ terms: [] })); return }
                const rows = await rwReadTab(token, 'rw_glossary', 'A:E')
                const terms = rows.slice(1).filter(r => r[0]).map(r => ({
                  term: r[0] || '', definition: r[1] || '', status: r[2] || 'provisional',
                  domain: r[3] || '', firstSeenDate: r[4] || '',
                }))
                res.end(JSON.stringify({ terms }))
              } catch { res.end(JSON.stringify({ terms: [] })) }
            })
          })

          // ── POST /api/rw/glossary/save ─────────────────────────────────────
          server.middlewares.use('/api/rw/glossary/save', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            readBody(req).then(async body => {
              try {
                const { term, action } = JSON.parse(body)
                if (!term?.term) { res.statusCode = 400; res.end(JSON.stringify({ error: 'term.term required' })); return }
                const token = await rwGetToken()
                if (!token || !rwSheetId) { res.statusCode = 503; res.end(JSON.stringify({ error: 'RW_SHEET_ID not configured' })); return }
                if (action === 'promote') {
                  const rowIdx = await rwFindRow(token, 'rw_glossary', 0, term.term)
                  if (rowIdx > 0) {
                    const rows = await rwReadTab(token, 'rw_glossary', `A${rowIdx}:E${rowIdx}`)
                    const r = rows[0] || []
                    await rwUpdateRow(token, 'rw_glossary', rowIdx, [r[0], r[1], 'confirmed', r[3], r[4]])
                  }
                } else {
                  const exists = await rwFindRow(token, 'rw_glossary', 0, term.term)
                  if (exists < 0) await rwAppendRow(token, 'rw_glossary', [term.term, term.definition, term.status || 'provisional', term.domain || '', term.firstSeenDate || new Date().toISOString().slice(0, 10)])
                }
                res.end(JSON.stringify({ success: true }))
              } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Error' })) }
            })
          })

          // ── GET /api/rw/feedback ───────────────────────────────────────────
          server.middlewares.use('/api/rw/feedback', (req: IncomingMessage, res, next) => {
            if (req.method !== 'GET') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            const url = new URL(req.url || '', 'http://localhost')
            const contributor = url.searchParams.get('contributor') || ''
            const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100)
            rwGetToken().then(async token => {
              try {
                if (!token || !rwSheetId) { res.end(JSON.stringify({ entries: [] })); return }
                const rows = await rwReadTab(token, 'rw_feedback', 'A:G')
                const entries = rows.slice(1)
                  .filter(r => !contributor || String(r[1] || '').trim() === contributor)
                  .slice(-limit)
                  .map((r, i) => ({
                    id: `fb_${i}`, date: r[0] || '', contributor: r[1] || '', reportType: r[2] || '',
                    category: r[3] || '', beforeText: r[4] || '', afterText: r[5] || '', lesson: r[6] || '',
                  }))
                res.end(JSON.stringify({ entries }))
              } catch { res.end(JSON.stringify({ entries: [] })) }
            })
          })

          // ── POST /api/rw/draft/save ────────────────────────────────────────
          server.middlewares.use('/api/rw/draft/save', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            readBody(req).then(async body => {
              try {
                const { draft } = JSON.parse(body)
                if (!draft?.contributor) { res.statusCode = 400; res.end(JSON.stringify({ error: 'draft.contributor required' })); return }
                const token = await rwGetToken()
                if (!token || !rwSheetId) { res.statusCode = 503; res.end(JSON.stringify({ error: 'RW_SHEET_ID not configured' })); return }
                const id = draft.id || `draft_${Date.now()}`
                await rwAppendRow(token, 'rw_drafts', [
                  id, draft.contributor, draft.reportType, new Date().toISOString(),
                  (draft.draftMd || '').slice(0, 49000), '', 'draft'
                ])
                res.end(JSON.stringify({ success: true, id }))
              } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Error' })) }
            })
          })

          // ── POST /api/rw/refine/save ───────────────────────────────────────
          server.middlewares.use('/api/rw/refine/save', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            res.setHeader('Content-Type', 'application/json')
            readBody(req).then(async body => {
              try {
                const { draftId, finalMd, feedback, updatedProfile } = JSON.parse(body)
                const token = await rwGetToken()
                if (!token || !rwSheetId) { res.statusCode = 503; res.end(JSON.stringify({ error: 'RW_SHEET_ID not configured' })); return }
                for (const fb of (feedback || [])) {
                  await rwAppendRow(token, 'rw_feedback', [
                    fb.date || new Date().toISOString().slice(0, 10),
                    fb.contributor, fb.reportType, fb.category,
                    (fb.beforeText || '').slice(0, 1000), (fb.afterText || '').slice(0, 1000), fb.lesson || '',
                  ])
                }
                if (draftId) {
                  const rowIdx = await rwFindRow(token, 'rw_drafts', 0, draftId)
                  if (rowIdx > 0) {
                    const rows = await rwReadTab(token, 'rw_drafts', `A${rowIdx}:G${rowIdx}`)
                    const r = rows[0] || []
                    await rwUpdateRow(token, 'rw_drafts', rowIdx, [r[0],r[1],r[2],r[3],r[4],(finalMd||'').slice(0,49000),'refined'])
                  }
                }
                if (updatedProfile?.id) {
                  const rowIdx = await rwFindRow(token, 'rw_profiles', 0, updatedProfile.id)
                  const row = [updatedProfile.id, updatedProfile.contributorName, JSON.stringify(updatedProfile), new Date().toISOString()]
                  if (rowIdx < 0) await rwAppendRow(token, 'rw_profiles', row)
                  else await rwUpdateRow(token, 'rw_profiles', rowIdx, row)
                }
                res.end(JSON.stringify({ success: true }))
              } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Error' })) }
            })
          })

          // ── POST /api/rw/learn (SSE) ───────────────────────────────────────
          server.middlewares.use('/api/rw/learn', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, contributor, existingProfile } = JSON.parse(body)
                const srcBlock = (sources || []).slice(0, 3).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 15000)}\n---`
                ).join('\n\n')
                const prompt = `CONTRIBUTOR: ${contributor}
EXISTING PROFILE: ${existingProfile ? JSON.stringify(existingProfile.voiceProfile, null, 2) : 'None — this is the first analysis.'}

PAST WRITING SAMPLES:
${srcBlock}

Analyse the writing samples above and return a JSON object with exactly these fields:
{
  "avgSentenceLength": "short|medium|long",
  "dominantTense": "past|present|mixed",
  "formalityLevel": "high|medium|low",
  "preferredConnectors": ["top 5 connecting words/phrases actually found in the text"],
  "avoidedWords": ["NGO/donor jargon absent from the writing, e.g. leverage, synergize, ecosystem, stakeholder"],
  "blindSpots": ["report sections consistently absent or thin — e.g. water quality data, gender disaggregation"],
  "anchorSentences": ["5 to 10 verbatim sentences that best represent this contributor's voice"],
  "recurringPitfalls": ${existingProfile ? JSON.stringify(existingProfile.voiceProfile?.recurringPitfalls || []) : '[]'},
  "lastLearnDate": "${new Date().toISOString().slice(0, 10)}"
}

Rules: anchorSentences must be verbatim from the text. Output ONLY the JSON object.`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a writing analyst for a rural development NGO in India. ' +
                  'Your job is to build a voice profile from a contributor\'s past writing. ' +
                  'Output ONLY a valid JSON object matching the specified schema. ' +
                  'Never invent characteristics — every attribute must be grounded in the text. ' +
                  'If insufficient data exists for a dimension, use an empty array or "mixed".',
                  res, 1200, 0.3
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/rw/draft (SSE) ───────────────────────────────────────
          server.middlewares.use('/api/rw/draft', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { sources, contributor, reportType, profile, glossary, recentFeedback } = JSON.parse(body)
                const templateMap: Record<string, { label: string; sections: string[]; hint: string }> = {
                  'field-visit-report': { label: 'Field Visit Report', sections: ['Purpose of Visit','Location & Date','Staff Present','Community / Beneficiaries Observed','Activities Conducted','Beneficiaries Reached','Key Observations','Challenges & Risks','Photographs / Attachments','Follow-up Actions'], hint: 'Use past tense. Every number must trace to source data.' },
                  'training-report':    { label: 'Training Report', sections: ['Training Title','Date & Venue','Facilitators','Participants (gender breakdown)','Training Objectives','Session Summary','Key Learning Outcomes','Participant Feedback','Materials Distributed','Follow-up & Gaps'], hint: 'Summarise what actually happened, not the planned curriculum.' },
                  'me-monthly-report':  { label: 'M&E Monthly Report', sections: ['Reporting Period','Project / Programme','Indicators Tracked','Beneficiary Data','Qualitative Progress','Deviations from Plan','Budget Utilisation','Risks & Mitigation','Lessons Learned','Plan for Next Month'], hint: 'Every number must trace to source. Format Indicators as a table: Indicator | Target | Achieved | Variance | Explanation.' },
                }
                const tpl = templateMap[reportType] || templateMap['field-visit-report']
                const vp  = profile?.voiceProfile
                const confirmedTerms = ((glossary as any[]) || []).filter((g: any) => g.status === 'confirmed').slice(0, 20)
                const recentLessons  = ((recentFeedback as any[]) || []).slice(-5).map((f: any) => `• ${f.lesson}`).join('\n')
                const srcBlock = ((sources as any[]) || []).map((s: any) => `[SOURCE: ${s.name}]\n${String(s.content||'').slice(0,20000)}\n---`).join('\n\n')
                const glossaryBlock = confirmedTerms.length > 0 ? confirmedTerms.map((g: any) => `${g.term} — ${g.definition}`).join('\n') : '(none yet)'
                const profileBlock  = vp ? `Sentence length: ${vp.avgSentenceLength} | Tense: ${vp.dominantTense} | Formality: ${vp.formalityLevel}
Preferred connectors: ${(vp.preferredConnectors||[]).join(', ')||'not known'}
Words to avoid: ${(vp.avoidedWords||[]).join(', ')||'none identified'}
Pitfalls to avoid: ${(vp.recurringPitfalls||[]).join('; ')||'none yet'}
Voice anchor sentences (write similarly to these):
${(vp.anchorSentences||[]).join('\n')}` : '(no profile yet — use plain professional English)'
                const prompt = `REPORT TYPE: ${tpl.label}
CONTRIBUTOR: ${contributor}

=== CONTRIBUTOR VOICE PROFILE ===
${profileBlock}

=== TEMPLATE — follow these sections in order ===
${tpl.sections.map((s: string, i: number) => `${i+1}. ${s}`).join('\n')}
Note: ${tpl.hint}

=== CONFIRMED GLOSSARY (use these exact terms) ===
${glossaryBlock}

=== RECENT EDITOR CORRECTIONS (do not repeat these mistakes) ===
${recentLessons || '(none yet)'}

=== RAW SOURCE DATA ===
${srcBlock}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a field report writer for Jal Jeevika, a rural development NGO focused on inland fisheries, water stewardship, and livelihoods in India.\n\n' +
                  'HARD RULES — never violate:\n' +
                  '1. Never fabricate field details. If a required piece of information is absent from sources, write ⟨MISSING: description of what is needed⟩\n' +
                  '2. Every number in the report must trace to source data. Do not round or estimate.\n' +
                  '3. Quotes must appear verbatim from source text, or not at all.\n' +
                  '4. Write in English. Regional terms appear in italics (*jal sahiya*) with a gloss in parentheses on first use.\n' +
                  '5. Do not use donor-speak (impactful, synergize, leverage, stakeholder, ecosystem) unless the contributor\'s own writing uses those terms.\n' +
                  '6. Follow the template section order exactly. Use markdown headings (## Section Name).',
                  res, 4096, 0.5
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/rw/refine (SSE) ──────────────────────────────────────
          server.middlewares.use('/api/rw/refine', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { draftMd, finalMd, contributor, reportType } = JSON.parse(body)
                const prompt = `CONTRIBUTOR: ${contributor}
REPORT TYPE: ${reportType}

=== DRAFT (AI-generated) ===
${String(draftMd||'').slice(0,8000)}

=== FINAL (contributor-edited) ===
${String(finalMd||'').slice(0,8000)}

Compare the two versions. For each meaningful change (ignore whitespace/formatting-only changes):
1. Identify the before-text (from draft) and after-text (from final).
2. Classify into one of: Voice / Structure / Vocabulary / Factual / Omission
   - Voice: contributor rewrote to sound more like themselves
   - Structure: section moved, split, or merged
   - Vocabulary: specific word or phrase replaced
   - Factual: number, name, or date corrected
   - Omission: content removed that should not have been in the draft
3. Write one lesson sentence starting with "In future: ..."

Return a JSON array FIRST, then on a new line write PROFILE_UPDATES: followed by a JSON object.

JSON array format:
[{"category":"Voice|Structure|Vocabulary|Factual|Omission","beforeText":"...","afterText":"...","lesson":"In future: ..."}]

PROFILE_UPDATES: {"avoidedWords":[],"blindSpots":[],"recurringPitfalls":[]}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a writing coach for an NGO field reporting system. ' +
                  'Compare draft vs final, classify every meaningful change, extract lessons. ' +
                  'Output the JSON array first, then PROFILE_UPDATES: followed by its JSON object. Nothing else.',
                  res, 2048, 0.4
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/rw/reflect (SSE) ─────────────────────────────────────
          server.middlewares.use('/api/rw/reflect', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { contributor, profile, recentFeedback } = JSON.parse(body)
                const feedbackBlock = ((recentFeedback as any[]) || []).slice(-30).map((f: any) =>
                  `[${f.date}] [${f.category}] BEFORE: "${String(f.beforeText||'').slice(0,120)}" → AFTER: "${String(f.afterText||'').slice(0,120)}" LESSON: ${f.lesson}`
                ).join('\n')
                const prompt = `CONTRIBUTOR: ${contributor}
CURRENT PROFILE:
${JSON.stringify(profile?.voiceProfile || {}, null, 2)}

RECENT CORRECTION HISTORY (last 4 weeks):
${feedbackBlock || '(no corrections recorded yet)'}

Tasks:
1. Identify the top 3 recurring pitfalls (patterns appearing in 2+ corrections).
2. Identify glossary terms from the corrections that appear consistently (3+ times) — candidates for promotion from provisional to confirmed.
3. Update the recurringPitfalls array.

Return ONLY this JSON object:
{
  "recurringPitfalls": ["..."],
  "termPromotions": ["term1"],
  "profileNote": "One paragraph summary of this contributor's patterns this period."
}`
                await callGeminiSSE(
                  apiKey, prompt,
                  'You are a learning system for an NGO field reporting tool. ' +
                  'Find recurring patterns in a contributor\'s correction history and consolidate them into actionable profile updates. ' +
                  'Output ONLY the specified JSON object.',
                  res, 1024, 0.4
                )
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

          // ── POST /api/rw/auto-polish (SSE) ────────────────────────────────
          // ── BigQuery: Finance & Attendance ───────────────────────
          let _bqDev: BigQuery | null = null
          function getBQDev() {
            if (!_bqDev) {
              const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}')
              _bqDev = new BigQuery({ projectId: creds.project_id || 'jaljeevika-baseline', credentials: creds })
            }
            return _bqDev
          }

          function bqRoute(table: string) {
            return (req: IncomingMessage, res: any, next: () => void) => {
              if (req.method !== 'GET') { next(); return }
              res.setHeader('Content-Type', 'application/json')
              const sendErr = (e: unknown) =>
                res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
              try {
                getBQDev()
                  .query(`SELECT * FROM \`jems-479908.jems_data.${table}\` LIMIT 1000`)
                  .then((result: any) => res.end(JSON.stringify(result[0])))
                  .catch(sendErr)
              } catch (e) { sendErr(e) }
            }
          }

          server.middlewares.use('/api/bq/finance',    bqRoute('finance'))
          server.middlewares.use('/api/bq/attendance', bqRoute('attendance'))

          server.middlewares.use('/api/rw/auto-polish', (req: IncomingMessage, res, next) => {
            if (req.method !== 'POST') { next(); return }
            setupNotebookSSE(res)
            readBody(req).then(async body => {
              try {
                const apiKey = (env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '')
                if (!apiKey) { res.write('data: ' + JSON.stringify({ error: 'GEMINI_API_KEY not set' }) + '\n\n'); res.end(); return }
                const { draftMd, sources, profile, reportType } = JSON.parse(body)
                const vp = (profile as any)?.voiceProfile
                const srcBlock = ((sources as any[]) || []).slice(0, 3).map((s: any) =>
                  `[SOURCE: ${s.name}]\n${String(s.content || '').slice(0, 15000)}\n---`
                ).join('\n\n')
                const voiceBlock = vp
                  ? `Length: ${vp.avgSentenceLength} | Tense: ${vp.dominantTense} | Formality: ${vp.formalityLevel}
Avoid: ${(vp.avoidedWords||[]).join(', ')||'none'}
Pitfalls: ${(vp.recurringPitfalls||[]).join('; ')||'none'}
Voice anchors:\n${(vp.anchorSentences||[]).join('\n')}`
                  : '(no voice profile — preserve original voice)'
                const prompt = `Polish this NGO field report draft. Do NOT add any fact not in sources or draft.

VOICE PROFILE:\n${voiceBlock}

RULES:
1. No invented facts, numbers, names, dates.
2. Resolve ⟨MISSING: ...⟩ placeholders where the answer is in sources; otherwise leave them.
3. Match contributor voice (length, tense, formality, connectors).
4. Fix listed pitfalls.
5. Output ONLY the polished markdown.

REPORT TYPE: ${reportType}

=== DRAFT ===\n${String(draftMd||'').slice(0,8000)}

=== SOURCES (for resolving MISSING) ===\n${srcBlock}`
                await callGeminiSSE(apiKey, prompt,
                  'You are an NGO report editor. Polish the draft to match the contributor voice profile. Output ONLY the final polished markdown.',
                  res, 4096, 0.4)
              } catch (e) {
                res.write('data: ' + JSON.stringify({ error: e instanceof Error ? e.message : 'Error' }) + '\n\n')
                res.end()
              }
            })
          })

        },
      },
    ],
  }
})
