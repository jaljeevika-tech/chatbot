// lib/correlationId.js — Express middleware that attaches a correlation ID to every request
// Propagates X-Correlation-ID from upstream callers (e.g. API Gateway) or generates a new one.
// The same ID is forwarded to downstream services so logs can be traced across services.

import { randomUUID } from 'crypto'

export function correlationId(req, res, next) {
  req.correlationId = req.headers['x-correlation-id'] || randomUUID()
  res.setHeader('x-correlation-id', req.correlationId)
  next()
}
