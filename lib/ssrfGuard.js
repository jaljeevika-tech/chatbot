// SSRF guard for tenant-controlled URLs the server fetches (WhatsApp flow webhook
// nodes). The server's network position is shared by every tenant, so this resolves
// the host and rejects private/loopback/link-local/CGNAT/multicast/reserved addresses;
// callers must fetch with `redirect: 'manual'`.
// Residual gap: DNS rebinding between this lookup and fetch()'s; it needs a pinned-IP
// dispatcher to close, and BLOCKED_HEADERS removes the metadata-server request shape.

import { lookup } from 'dns/promises'
import net from 'net'

function _v4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}
function _inV4(ip, cidr) {
  const [base, bits] = cidr.split('/')
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0
  return (_v4ToInt(ip) & mask) === (_v4ToInt(base) & mask)
}
const V4_BLOCKED = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
]

export function isPrivateAddress(ip) {
  const kind = net.isIP(ip)
  if (kind === 4) return V4_BLOCKED.some(c => _inV4(ip, c))
  if (kind === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    // IPv4-mapped / NAT64 — judge by the embedded v4 address
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    const first = parseInt(lower.split(':')[0] || '0', 16)
    if ((first & 0xfe00) === 0xfc00) return true   // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true   // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true   // ff00::/8 multicast
    return false
  }
  return true  // not an IP at all — treat as unsafe
}

/** Resolve `url` and return null if it's a safe public http(s) target, else a reason string. */
export async function checkPublicUrl(url) {
  let u
  try { u = new URL(String(url)) } catch { return 'invalid URL' }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http/https allowed'
  if (u.username || u.password) return 'credentials in URL not allowed'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host || /^(localhost|metadata(\.google\.internal)?)\.?$/i.test(host) || /\.internal\.?$/i.test(host)) {
    return 'internal host'
  }
  let addrs
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  } catch { return 'DNS lookup failed' }
  if (!addrs.length) return 'DNS lookup failed'
  if (addrs.some(a => isPrivateAddress(a.address))) return 'resolves to a private/internal address'
  return null
}

// Headers a flow author must not be able to set on a server-side request:
// they either impersonate the server to internal services (Metadata-Flavor is
// what the GCP metadata server requires) or smuggle routing/hop semantics.
const BLOCKED_HEADERS = new Set([
  'host', 'metadata-flavor', 'x-google-metadata-request', 'x-forwarded-for',
  'x-forwarded-host', 'x-real-ip', 'forwarded', 'proxy-authorization',
  'connection', 'transfer-encoding', 'content-length', 'te', 'upgrade',
])
export function sanitizeOutboundHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (BLOCKED_HEADERS.has(String(k).toLowerCase())) continue
    out[k] = String(v)
  }
  return out
}
