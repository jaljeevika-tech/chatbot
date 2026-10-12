// Run: node lib/ssrfGuard.check.mjs — self-check for the SSRF private-address guard.
import assert from 'node:assert/strict'
import { isPrivateAddress, checkPublicUrl } from './ssrfGuard.js'

// IPv4 embedded in IPv6, in the hex form URL parsing produces and the dotted form DNS can return.
for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '::7f00:1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::1', 'fd00::1', 'fe80::1']) {
  assert.equal(isPrivateAddress(ip), true, ip)
}
for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '2001:4860::8888', '8.8.8.8']) {
  assert.equal(isPrivateAddress(ip), false, ip)
}

// End to end through URL parsing (IP literals, no DNS).
for (const url of ['http://[::ffff:127.0.0.1]:9/', 'http://[::ffff:169.254.169.254]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::10.0.0.1]/', 'http://127.0.0.1/']) {
  assert.notEqual(await checkPublicUrl(url), null, url)
}
assert.equal(await checkPublicUrl('http://[::ffff:8.8.8.8]/'), null)

console.log('ssrfGuard check: OK')
