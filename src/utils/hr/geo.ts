// One GPS fix for a check-in/out. Never rejects: a failure comes back as a
// status the server records (and flags when the org requires GPS).
// Phones have GPS hardware and get a fix offline; laptops locate over Wi-Fi
// and usually come back 'unavailable' without a connection.

import type { LocationFix } from '../../types/hr'

export function getLocationFix(timeoutMs = 15_000): Promise<LocationFix> {
  if (!('geolocation' in navigator)) return Promise.resolve({ status: 'unavailable' })
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        status: 'ok',
        lat: Number(pos.coords.latitude.toFixed(6)),
        lng: Number(pos.coords.longitude.toFixed(6)),
        accuracy: Math.round(pos.coords.accuracy),
      }),
      err => resolve({ status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    )
  })
}

export const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`
