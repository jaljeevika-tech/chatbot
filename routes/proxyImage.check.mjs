// node routes/proxyImage.check.mjs — image allowlist for /api/proxy-image
import assert from 'node:assert'
import { isAllowedImageUrl } from './reports.routes.js'

const UUID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

// WhatsApp report photos served by our own /api/wa/media route
assert.equal(isAllowedImageUrl(`https://app.example.org/api/wa/media/${UUID}`), true)
assert.equal(isAllowedImageUrl(`http://localhost:8080/api/wa/media/${UUID}`), true)
// still only the uuid shape, and nothing else on our own host
assert.equal(isAllowedImageUrl('https://app.example.org/api/wa/media/../../etc/passwd'), false)
assert.equal(isAllowedImageUrl('https://app.example.org/api/reports/daily'), false)

// Drive / Google hosts unchanged
assert.equal(isAllowedImageUrl('https://drive.google.com/thumbnail?id=abc&sz=w800'), true)
assert.equal(isAllowedImageUrl('https://lh3.googleusercontent.com/d/abc'), true)
assert.equal(isAllowedImageUrl('http://drive.google.com/thumbnail?id=abc'), false) // https only
assert.equal(isAllowedImageUrl('https://evil.example.com/x.png'), false)
assert.equal(isAllowedImageUrl('http://169.254.169.254/latest/meta-data'), false)

console.log('proxyImage.check: ok')
