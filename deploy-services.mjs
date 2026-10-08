// Build + deploy the six Cloud Run services from this checkout (no local Docker needed:
// images build on Cloud Build). Run AFTER the App Engine deploy. Stops at the first failure.
//   node deploy-services.mjs [service ...]
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const project = 'chatbot-492915'
const tag = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
const all = ['notebook', 'report-writer', 'individual-beneficiary', 'micro-entrepreneur', 'collective', 'resource']
const services = process.argv.length > 2 ? process.argv.slice(2) : all

const run = cmd => { console.log(`\n> ${cmd}`); execSync(cmd, { cwd: root, stdio: 'inherit' }) }

for (const s of services) {
  if (!all.includes(s)) throw new Error(`unknown service: ${s}`)
  const image = `asia-south1-docker.pkg.dev/${project}/cloud-run-source-deploy/fieldflow-${s}:${tag}`
  run(`gcloud builds submit --project ${project} --config cloudbuild.services.yaml --ignore-file cloudrun.gcloudignore --substitutions _SERVICE=${s},_TAG=${tag} .`)
  run(`gcloud run deploy fieldflow-${s} --project ${project} --region asia-south1 --image ${image} --quiet`)
  console.log(`\n✓ ${s} deployed (${tag})`)
}
console.log('\nAll done.')
