/** Fetch with the Firebase ID token (live, else sessionStorage ff_token); on 401 it
 * force-refreshes the token and retries once. */

import { getApps, getApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'

async function getToken(forceRefresh = false): Promise<string | null> {
  try {
    if (!getApps().length) return sessionStorage.getItem('ff_token')

    const currentUser = getAuth(getApp()).currentUser
    if (!currentUser) return sessionStorage.getItem('ff_token')

    const token = await currentUser.getIdToken(forceRefresh)
    if (token) sessionStorage.setItem('ff_token', token)
    return token
  } catch {
    return sessionStorage.getItem('ff_token')
  }
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token   = await getToken()
  const headers = new Headers(init.headers)
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(url, { ...init, headers })

  if (res.status === 401) {
    const freshToken = await getToken(true)
    if (freshToken) {
      const retryHeaders = new Headers(init.headers)
      retryHeaders.set('Authorization', `Bearer ${freshToken}`)
      return fetch(url, { ...init, headers: retryHeaders })
    }
  }

  return res
}
