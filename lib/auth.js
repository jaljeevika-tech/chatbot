// lib/auth.js — Firebase Admin initialisation + Express auth middleware

import admin from 'firebase-admin'

let _firebaseReady = false

export function ensureFirebase() {
  if (_firebaseReady) return
  _firebaseReady = true
  try {
    if (!admin.apps.length) {
      const keyJson = (process.env.FIREBASE_ADMIN_SDK_JSON || '').trim()
      const credential = keyJson
        ? admin.credential.cert(JSON.parse(keyJson))
        : admin.credential.applicationDefault()
      admin.initializeApp({
        credential,
        projectId: process.env.FIREBASE_PROJECT_ID || 'chatbot-5304f',
      })
    }
    console.log('[auth] Firebase Admin initialized')
  } catch (e) {
    console.warn('[auth] Firebase Admin init failed:', e.message)
    _firebaseReady = false
  }
}

/** Verifies Firebase ID token and injects req.user = { uid, orgId, role, phone } */
export async function requireAuth(req, res, next) {
  ensureFirebase()
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization: Bearer <token> required' })
  }
  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7), true)
    req.user = {
      uid:   decoded.uid,
      orgId: decoded.orgId || null,
      role:  decoded.role  || 'employee',
      name:  decoded.name  || '',
      // Standard phone claim; lets POST /auth/login fall back to a phone lookup
      // when firebase_uid isn't linked to a users row yet.
      phone: decoded.phone_number || null,
    }
    next()
  } catch (e) {
    const msg = e.code === 'auth/id-token-expired' ? 'Token expired' : 'Invalid token'
    return res.status(401).json({ error: msg })
  }
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' })
  }
  next()
}

export { admin }
