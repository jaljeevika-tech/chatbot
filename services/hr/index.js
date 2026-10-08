// FieldFlow HR microservice (attendance + leave); owns the hr_* tables (078) via
// the hr_service role. Only the monolith calls it, forwarding the verified caller as
// x-org-id / x-firebase-uid / x-user-role / x-user-phone; deploy private, with
// HR_INTERNAL_TOKEN set on both sides (sent as x-internal-token). The same routes run
// in-process via routes/hr.routes.js when HR_SERVICE_URL is unset or this service is
// down. Setup shared with the other services: lib/serviceApp.js.
//
// Local:  DB_HOST=… DB_PASSWORD=… node services/hr/index.js        (port 8086)
// Build context is the REPO ROOT (it reuses lib/serviceApp.js):
//   docker build -f services/hr/Dockerfile -t asia-south1-docker.pkg.dev/<project>/fieldflow/hr .
//   docker push asia-south1-docker.pkg.dev/<project>/fieldflow/hr
//   gcloud run deploy fieldflow-hr --image asia-south1-docker.pkg.dev/<project>/fieldflow/hr \
//     --region asia-south1 --no-allow-unauthenticated --add-cloudsql-instances <instance> \
//     --set-env-vars HR_DB_USER=hr_service --set-secrets HR_DB_PASSWORD=HR_DB_PASSWORD:latest

import { createServiceApp } from '../../lib/serviceApp.js'
import { createHrRouter } from './router.js'
import { UUID_RE } from './context.js'

const PORT = process.env.PORT || 8086

createServiceApp({
  name: 'hr', version: '1.0.0', keyEnv: 'HR_INTERNAL_TOKEN',
  keyHeader: 'x-internal-token', keyError: 'Unauthorized', identityError: 'Missing caller identity',
  identityKey: 'hrIdent',
  identity: req => {
    const orgId = String(req.headers['x-org-id'] || '')
    const uid   = String(req.headers['x-firebase-uid'] || '')
    if (!UUID_RE.test(orgId) || !uid) return null
    return {
      orgId, uid,
      role:  String(req.headers['x-user-role'] || 'employee'),
      phone: String(req.headers['x-user-phone'] || ''),
    }
  },
  mount: app => app.use('/api', createHrRouter()),
}).listen(PORT, () => console.log(`[hr] listening on ${PORT}`))
