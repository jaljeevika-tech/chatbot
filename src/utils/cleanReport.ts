// Cleans field reports from Google Sheets: fuzzy-match fields against canonical
// lists, infer garbage values from the description, else fall back to 'Other' / ''.

import type { DailyReport } from '../types/report'

// ── Canonical value lists ─────────────────────────────────────────────────────

export const CANONICAL_PROJECTS: string[] = [
  'Dasara',
  'Kosi Sahajivan',
  'UNDP ECRIC Project',
  'TATWA',
  'Internal Program',
  'Arogya Anna Herbelife',
  'FPO Madhepura – NABARD',
  'Jal Nidhi – Herbalife',
  'Water Hyacinth – NABARD',
  'Jal Smaridhi-APF',
  'Shabri Mahamandal',
]

export const CANONICAL_STATES: string[] = [
  'Bihar',
  'Maharashtra',
  'Madhya Pradesh',
  'Uttar Pradesh',
  'Telangana',
  'Jharkhand',
  'Odisha',
  'West Bengal',
  'Rajasthan',
  'Chhattisgarh',
  'Andhra Pradesh',
  'Karnataka',
  'Tamil Nadu',
  'Gujarat',
  'Punjab',
  'Haryana',
]

export const CANONICAL_AREAS: string[] = [
  'Community Mobilization',
  'Beneficiary Training',
  'Beneficiary Exposure Visit',
  'Beneficiary Input Distribution',
  'Camp & Convergence',
  'Collective Development',
  'Documentation & Report',
  'Donor Relations',
  'Enterprise Development Support',
  'Input & Financial Linkage',
  'MIS & Analysis',
  'Any Other',
]

// ── Alias maps (alternate spellings / common mistakes → canonical) ──────────

const PROJECT_ALIASES: Record<string, string> = {
  'kosi sahjeevan':              'Kosi Sahajivan',
  'kosi sahajeevan':             'Kosi Sahajivan',
  'kosi sahajivan':              'Kosi Sahajivan',
  'kosi sahjivan':               'Kosi Sahajivan',
  'kosi shajivan':               'Kosi Sahajivan',
  'kosi sahjeevan program':      'Kosi Sahajivan',
  'kosi':                        'Kosi Sahajivan',
  'undp':                        'UNDP ECRIC Project',
  'undp ecric':                  'UNDP ECRIC Project',
  'ecric':                       'UNDP ECRIC Project',
  // Bundelkhand Jaljeevika merged into Jal Nidhi – Herbalife (project consolidation)
  'bundelkhand':                 'Jal Nidhi – Herbalife',
  'bundelkhand jaljeevika':      'Jal Nidhi – Herbalife',
  'jaljeevika':                  'Jal Nidhi – Herbalife',
  'tatwa':                       'TATWA',
  'tao guhagar':                 'Internal Program',
  'guhaghar':                    'Internal Program',
  'ratnagiri':                   'Internal Program',
  'farm':                        'Internal Program',
  'report':                      'Internal Program',
  'next':                        'Internal Program',
  'community meetings':          'Internal Program',
  'रिपोर्ट':                     'Internal Program',
  'funded':                      'Internal Program',
  'arogya':                      'Arogya Anna Herbelife',
  'herbelife':                   'Arogya Anna Herbelife',
  'herbalife':                   'Arogya Anna Herbelife',
  'jal nidhi':                   'Jal Nidhi – Herbalife',
  'jal smaridhi':                'Jal Smaridhi-APF',
  'fpo madhepura':               'FPO Madhepura – NABARD',
  'fpo':                         'FPO Madhepura – NABARD',
  'nabard':                      'FPO Madhepura – NABARD',
  'water hyacinth':              'Water Hyacinth – NABARD',
  'shabri':                      'Shabri Mahamandal',
  'dasara':                      'Dasara',
  'internal':                    'Internal Program',
  // Jaljeevika Academy + internship + farm management roll up to Internal Program
  'donor project':               'Internal Program',
  'donor':                       'Internal Program',
  'jaljeevika academy':          'Internal Program',
  'jaljeevika acad':             'Internal Program',
  'academy':                     'Internal Program',
  'jal academy':                 'Internal Program',
  'internship':                  'Internal Program',
  'intern':                      'Internal Program',
  'interns':                     'Internal Program',
  'farm management':             'Internal Program',
  'farm mgmt':                   'Internal Program',
  'farm mngmt':                  'Internal Program',
}

const STATE_ALIASES: Record<string, string> = {
  'bihar':           'Bihar',
  'bih':             'Bihar',
  'maharashtra':     'Maharashtra',
  'maha':            'Maharashtra',
  'madhya pradesh':  'Madhya Pradesh',
  'mp':              'Madhya Pradesh',
  'मध्य प्रदेश':    'Madhya Pradesh',
  'uttar pradesh':   'Uttar Pradesh',
  'up':              'Uttar Pradesh',
  'telangana':       'Telangana',
  'jharkhand':       'Jharkhand',
  'odisha':          'Odisha',
  'west bengal':     'West Bengal',
  'bengal':          'West Bengal',
  'rajasthan':       'Rajasthan',
  'chhattisgarh':    'Chhattisgarh',
  'andhra':          'Andhra Pradesh',
  'andhra pradesh':  'Andhra Pradesh',
  'karnataka':       'Karnataka',
}

const AREA_ALIASES: Record<string, string> = {
  'community mobilization':              'Community Mobilization',
  'community':                           'Community Mobilization',
  'mobilization':                        'Community Mobilization',
  'community meetings':                  'Community Mobilization',
  'community meeting':                   'Community Mobilization',
  'beneficiary training':                'Beneficiary Training',
  'training':                            'Beneficiary Training',
  'benf. training':                      'Beneficiary Training',
  'exposure visit':                      'Beneficiary Exposure Visit',
  'benf. exposure visit':                'Beneficiary Exposure Visit',
  'exposure':                            'Beneficiary Exposure Visit',
  'input distribution':                  'Beneficiary Input Distribution',
  'benf. input distribution':            'Beneficiary Input Distribution',
  'input':                               'Beneficiary Input Distribution',
  'camp':                                'Camp & Convergence',
  'camp & convergence':                  'Camp & Convergence',
  'convergence':                         'Camp & Convergence',
  'collective development':              'Collective Development',
  'collective':                          'Collective Development',
  'documentation':                       'Documentation & Report',
  'documentation & report':              'Documentation & Report',
  'report':                              'Documentation & Report',
  'mis':                                 'MIS & Analysis',
  'mis & analysis':                      'MIS & Analysis',
  'analysis':                            'MIS & Analysis',
  'donor':                               'Donor Relations',
  'donor relations':                     'Donor Relations',
  'enterprise':                          'Enterprise Development Support',
  'enterprise dev':                      'Enterprise Development Support',
  'ent. dev. support':                   'Enterprise Development Support',
  'input & fin. linkage.':               'Input & Financial Linkage',
  'input & financial linkage':           'Input & Financial Linkage',
  'financial linkage':                   'Input & Financial Linkage',
  'any other':                           'Any Other',
  'other':                               'Any Other',
}

// ── Keyword-based inference from description ──────────────────────────────────

const PROJECT_KEYWORDS: [RegExp, string][] = [
  [/kosi|sahajeevan|sahjeevan|sahajivan|sahjivan|shajivan|jhang|makhana|supaul|madhepura|darbhanga|purnia|bihar.*(fish|pond|jheel)/i, 'Kosi Sahajivan'],
  // Not bare "climate": other projects use it too and would be misfiled as UNDP ECRIC.
  [/undp|ecric|gcf/i,                                   'UNDP ECRIC Project'],
  // Bundelkhand Jaljeevika merged into Jal Nidhi – Herbalife; legacy reports still match.
  [/bundelkhand|jhansi|sagar|mp.*(pond|fish)/i,         'Jal Nidhi – Herbalife'],
  [/tatwa|tattwa|jaljeevika.*(team|office|tool|report|dashboard|app)/i, 'TATWA'],
  [/guhaghar|guhagaon|ratnagiri|padave|rajapur|konkan|tao/i, 'Internal Program'],
  [/arogya|herbalife|herbelife/i,                        'Arogya Anna Herbelife'],
  [/jal nidhi|jaljeevika/i,                              'Jal Nidhi – Herbalife'],
  [/jal smaridhi|jalsmridhi/i,                           'Jal Smaridhi-APF'],
  [/fpo.*madhepura|nabard.*madhepura|madhepura.*fpo/i,   'FPO Madhepura – NABARD'],
  [/water hyacinth/i,                                    'Water Hyacinth – NABARD'],
  [/shabri|mahamandal/i,                                 'Shabri Mahamandal'],
  [/dasara|dussehra/i,                                   'Dasara'],
]

const STATE_KEYWORDS: [RegExp, string][] = [
  [/bihar|patna|muzaffarpur|gaya|supaul|purnia|darbhanga|sitamarhi|madhubani|saharsa|bhagalpur|kishanganj|araria|katihar/i, 'Bihar'],
  [/maharashtra|pune|mumbai|nagpur|nashik|aurangabad|thane|ratnagiri|konkan|kolhapur|sangli|solapur|amravati/i, 'Maharashtra'],
  [/madhya pradesh|bhopal|indore|jabalpur|gwalior|ujjain|sagar|rewa|satna|ratlam|dewas|chhindwara/i, 'Madhya Pradesh'],
  [/uttar pradesh|lucknow|kanpur|agra|varanasi|allahabad|prayagraj|gorakhpur|meerut|bareilly|aligarh|moradabad|saharanpur|firozabad|jhansi/i, 'Uttar Pradesh'],
  [/telangana|hyderabad|warangal|karimnagar|nizamabad|khammam|nalgonda|kagaznagar|adilabad/i, 'Telangana'],
  [/jharkhand|ranchi|jamshedpur|dhanbad|bokaro|hazaribagh|dumka/i, 'Jharkhand'],
  [/odisha|bhubaneswar|cuttack|rourkela|puri|sambalpur/i, 'Odisha'],
  [/west bengal|kolkata|howrah|asansol|siliguri|durgapur/i, 'West Bengal'],
]

const AREA_KEYWORDS: [RegExp, string][] = [
  [/training|workshop|kapasit|capacity.build|siksha|shikshan|प्रशिक्षण/i, 'Beneficiary Training'],
  [/exposure.visit|field.visit.*exposure|visited.*farmer|farmer.*visit/i, 'Beneficiary Exposure Visit'],
  [/input.distribut|seed.distribut|distribut.*input|वितरण/i, 'Beneficiary Input Distribution'],
  [/camp|convergence|mela|sammelan|सम्मेलन/i, 'Camp & Convergence'],
  [/meeting|samuh|shg|self.help|समूह|बैठक|sanstha/i, 'Community Mobilization'],
  [/document|report|data.entry|mis|record|form.fill|excel|sheet|format/i, 'Documentation & Report'],
  [/survey|analysis|mapping|assessment|baseline|evaluation|monitoring|indicator/i, 'MIS & Analysis'],
  [/donor|fund|csr|grant|proposal|ngo.*partner|partner.*ngo/i, 'Donor Relations'],
  [/enterprise|business|udyam|rozgar|livelihood|income|आजीविका|रोजगार/i, 'Enterprise Development Support'],
  [/loan|credit|bank|linkage|financial|microfinance|swayamsidha|finance/i, 'Input & Financial Linkage'],
  [/collective|federation|producer|group.develop|shg.develop/i, 'Collective Development'],
]

// ── Utility functions ─────────────────────────────────────────────────────────

/** True if the value looks like garbage (URL, very long, clearly wrong field) */
function looksGarbage(val: string): boolean {
  if (!val || val.trim().length === 0) return true
  const v = val.trim()
  if (v.startsWith('http') || v.startsWith('https') || v.includes('drive.google')) return true
  if (v.startsWith('%20') || v.includes('%20')) return true   // URL-encoded text
  if (/^\d+$/.test(v)) return true                            // pure number
  if (v.length > 80) return true                              // too long to be a category
  if (v.includes('@results')) return true                     // code leak
  if (/^(na|n\/a|nil|none|no|0|null|-|na)$/i.test(v)) return true
  return false
}

/** Fuzzy lookup against alias map + canonical list. Dash variants are normalised
 *  first so "Water Hyacinth-NABARD" resolves to "Water Hyacinth – NABARD". */
function fuzzyMatch(raw: string, aliases: Record<string, string>, canonical: string[]): string | null {
  const key = raw.trim().toLowerCase()
    // Canonical names use " – " (spaced en-dash).
    .replace(/\s*[\-–—]\s*/g, ' – ')
  if (aliases[key]) return aliases[key]

  for (const c of canonical) {
    const cKey = c.toLowerCase()
    if (cKey === key) return c
    if (cKey.startsWith(key) || key.startsWith(cKey)) return c
    // Contains match (both ways)
    if (cKey.includes(key) || key.includes(cKey)) return c
  }
  return null
}

/** Infer a field value from description text using keyword patterns */
function inferFromDescription(description: string, location: string, keywords: [RegExp, string][]): string | null {
  const text = `${description} ${location}`.toLowerCase()
  for (const [regex, value] of keywords) {
    if (regex.test(text)) return value
  }
  return null
}

/** Names that are clearly placeholder/test rows and must never be stored as
 *  a real contributor. Case-insensitive exact match. */
const GARBAGE_NAMES = new Set([
  'test', 'report', 'next', 'na', 'n/a', 'nil', 'none', 'no', 'null',
  'unknown', 'user', 'admin', 'demo', 'sample', 'temp', 'tmp',
  'रिपोर्ट',           // "report" in Hindi
])

/** Title-case a Latin-only string, preserving non-Latin characters as-is.
 *  e.g. "amar kumar" → "Amar Kumar", "सुनीता devi" → "सुनीता Devi" */
function titleCaseLatin(s: string): string {
  return s.replace(/[A-Za-z][a-zA-Z']*/g, w =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  )
}

/** Clean and normalize contributor name */
function cleanName(raw: string): string {
  const v = raw?.trim() ?? ''
  // Garbage patterns
  if (looksGarbage(v)) return ''
  if (v.length > 60) return ''         // full sentences bleed in
  if (/^\d/.test(v)) return ''         // starts with digit
  if (v.includes('http')) return ''
  if (/[।।॥]/.test(v) && v.length > 40) return '' // long Hindi sentences
  // Explicit placeholder words ("test", "report", etc.)
  if (GARBAGE_NAMES.has(v.toLowerCase())) return ''

  // Known name variants roll up to one canonical contributor.
  const normalized: Record<string, string> = {
    'neelkanth mishra': 'Neelkanth Mishra',
    'neelkanth':        'Neelkanth Mishra',
    'jeevan padwal':    'Jeevan Padwal',
    'riya kumari':      'Riya Kumari',
    'dilip sada':       'Dilip Sada',
    'vishwesh satish chaudhari': 'Vishwesh Satish Chaudhari',
    'omkar vasant balel':        'Omkar Vasant Balel',
    'jayram kevat':     'जयराम केवट',
    'jayaram':          'जयराम केवट',

    'amar kumar':       'Amar Kumar',
    // Assumes a single Rakesh in the roster.
    'rakesh':           'Rakesh Kumar',
    'rakesh kumar':     'Rakesh Kumar',

    'aditya pratap singh parmar': 'Aditya Pratap Singh Parmar',
    'ajay nagnath kharat':        'Ajay Nagnath Kharat',
    'anjana prasad':              'Anjana Prasad',
    'ankita patil':               'Ankita Patil',
    'arvind mukhiya':             'Arvind Mukhiya',
    'avinash kumar':              'Avinash Kumar',
    'harsh kumar dixit':          'Harsh Kumar Dixit',
    'ishan deepak kalzunkar':     'Ishan Deepak Kalzunkar',
    'kaithoju srinivas':          'Kaithoju Srinivas',
    'kundan kunal':               'Kundan Kunal',
    'loknath gavde':              'Loknath Gavde',
    'manish kumar':               'Manish Kumar',
    'minati sarkar':              'Minati Sarkar',
    'prajyot anant kamble':       'Prajyot Anant Kamble',
    'rajkumar kamble':            'Rajkumar Kamble',
    'rajkumar kushwaha':          'Rajkumar Kushwaha',
    'ramashish kumar':            'Ramashish Kumar',
    'shubham sanjay waingankar':  'Shubham Sanjay Waingankar',
    'srushti surve':              'Srushti Surve',
    'sujit kumar jha':            'Sujit Kumar Jha',
    'sumit kule':                 'Sumit Kule',
    'vishal kumar mahto':         'Vishal Kumar Mahto',
    'सुनीता devi':                'सुनीता Devi',
  }
  const hit = normalized[v.toLowerCase()]
  if (hit) return hit

  // Title-case Latin names so case slips don't split one person into two rows.
  if (/^[A-Za-z\s.\-']+$/.test(v)) return titleCaseLatin(v)
  return v
}

// ── Main cleaner ──────────────────────────────────────────────────────────────

export function cleanReport(report: DailyReport): DailyReport {
  const desc = String(report.description || '')
  const loc  = String(report.location || '')

  // ── Project ────────────────────────────────────────────
  let project = String(report.project || '').trim()
  if (looksGarbage(project)) {
    project = inferFromDescription(desc, loc, PROJECT_KEYWORDS) ?? ''
  } else {
    project = fuzzyMatch(project, PROJECT_ALIASES, CANONICAL_PROJECTS)
      ?? inferFromDescription(desc, loc, PROJECT_KEYWORDS)
      ?? project
  }

  // Prefer a specific project inferred from the text over the generic bucket.
  if (project === 'Internal Program' || project === '') {
    project = inferFromDescription(desc, loc, PROJECT_KEYWORDS) ?? 'Internal Program'
  }

  // ── State ──────────────────────────────────────────────
  let state = String(report.state || '').trim()
  if (looksGarbage(state)) {
    state = inferFromDescription(desc, loc, STATE_KEYWORDS) ?? ''
  } else {
    state = fuzzyMatch(state, STATE_ALIASES, CANONICAL_STATES)
      ?? inferFromDescription(desc, loc, STATE_KEYWORDS)
      ?? state
  }

  // ── Area of Intervention ───────────────────────────────
  let area = String(report.areaOfIntervention || '').trim()
  if (looksGarbage(area)) {
    area = inferFromDescription(desc, loc, AREA_KEYWORDS) ?? 'Any Other'
  } else {
    area = fuzzyMatch(area, AREA_ALIASES, CANONICAL_AREAS)
      ?? inferFromDescription(desc, loc, AREA_KEYWORDS)
      ?? area
  }

  // MIS & Analysis work rolls up to TATWA unless a specific programme is tagged.
  if (area === 'MIS & Analysis' && (project === 'Internal Program' || project === '' || !project)) {
    project = 'TATWA'
  }

  // ── Location ───────────────────────────────────────────
  let location = String(report.location || '').trim()
  if (looksGarbage(location)) location = ''
  // Strip URL-encoded chars
  if (location.includes('%')) {
    try { location = decodeURIComponent(location) } catch { location = '' }
  }

  // ── Name ───────────────────────────────────────────────
  const name = cleanName(report.name) || report.name

  // ── Attachment URL ─────────────────────────────────────
  // Sometimes the Drive URL ends up in the wrong column and vice versa
  let attachmentUrl = report.attachmentUrl
  if (attachmentUrl && !attachmentUrl.startsWith('http')) attachmentUrl = null
  // Also check if a Drive URL was accidentally put in the description
  if (!attachmentUrl) {
    const driveMatch = desc.match(/https:\/\/drive\.google\.com\/file\/d\/[^\s"']+/)
    if (driveMatch) attachmentUrl = driveMatch[0]
  }
  // Clean WhatsApp CDN URLs that are not Drive
  if (attachmentUrl && !attachmentUrl.includes('drive.google') && !attachmentUrl.includes('lh3.google')) {
    attachmentUrl = null
  }

  // ── Beneficiaries ──────────────────────────────────────
  const rawBenef = String(report.beneficiaries ?? '0').trim()
  let benefNum = 0
  if (!rawBenef.includes('http') && rawBenef.length < 100) {
    if (!rawBenef.match(/^\d{1,2}\/\d{1,2}\/\d{2,4}/)) {
      const match = rawBenef.match(/\d+/)
      if (match) {
        benefNum = parseInt(match[0], 10)
        if (benefNum > 100000) benefNum = 0
      }
    }
  }

  return {
    ...report,
    name:               name || report.name,
    project:            project || report.project,
    state:              state   || report.state,
    areaOfIntervention: area    || report.areaOfIntervention,
    location:           location || report.location,
    attachmentUrl,
    beneficiaries:      benefNum,
  }
}

export function cleanReports(reports: DailyReport[]): DailyReport[] {
  return reports
    .map(cleanReport)
    .filter(r => {
      // Drop completely empty/garbage rows
      const hasName = r.name && r.name.length > 0 && r.name.length < 80
      const hasDesc = r.description && r.description.length > 5
      return hasName && hasDesc
    })
}
