// routes/finance.routes.js — BigQuery Finance & Attendance routes
// GET /api/bq/finance
// GET /api/bq/attendance

import { Router } from 'express'
import { BigQuery } from '@google-cloud/bigquery'
import { getOrg } from '../lib/org.js'

const router = Router()

// Whitelist BQ identifiers — only alphanumeric/dash/underscore
const BQ_ID_RE = /^[a-zA-Z0-9_-]{1,256}$/
function safeBqId(val, fallback) {
  return BQ_ID_RE.test(String(val || '')) ? String(val) : fallback
}

let _bqClient = null

function getBQClient() {
  if (!_bqClient) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    _bqClient = new BigQuery({ projectId: creds.project_id || 'jaljeevika-baseline', credentials: creds })
  }
  return _bqClient
}

router.get('/bq/finance', async (req, res) => {
  try {
    const orgId = req.user.orgId
    // A token with no orgId claim must never fall through to an unscoped query —
    // that would return every tenant's finance data. Deny instead.
    if (!orgId) return res.status(403).json({ error: 'No organization associated with this account.' })

    const org = await getOrg(orgId).catch(() => null)
    const bqProject = safeBqId(org?.metadata?.data_sources?.bq_project, 'jems-479908')
    const bqDataset = safeBqId(org?.metadata?.data_sources?.bq_dataset, 'jems_data')

    const [rows] = await getBQClient().query({
      query: `SELECT * FROM \`${bqProject}.${bqDataset}.finance\` WHERE org_id = @orgId LIMIT 1000`,
      params: { orgId },
    })
    res.json(rows)
  } catch (e) {
    console.error('[finance]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/bq/attendance', async (req, res) => {
  try {
    const orgId = req.user.orgId
    if (!orgId) return res.status(403).json({ error: 'No organization associated with this account.' })

    const org = await getOrg(orgId).catch(() => null)
    const bqProject = safeBqId(org?.metadata?.data_sources?.bq_project, 'jems-479908')
    const bqDataset = safeBqId(org?.metadata?.data_sources?.bq_dataset, 'jems_data')

    const [rows] = await getBQClient().query({
      query: `SELECT * FROM \`${bqProject}.${bqDataset}.attendance\` WHERE org_id = @orgId LIMIT 1000`,
      params: { orgId },
    })
    res.json(rows)
  } catch (e) {
    console.error('[finance]', e)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
