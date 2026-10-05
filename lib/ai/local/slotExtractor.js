// lib/ai/local/slotExtractor.js — Deterministic slot value extraction
//
// Handles the most common field types without any AI call:
//   number   — digits, words, Hindi numerals, fractions, ranges
//   date     — ISO, DD/MM/YYYY, relative (today/yesterday/aaj/kal), weekday names
//   yesno    — yes/no/haan/nahi/ok/na and regional equivalents
//   phone    — Indian 10-digit mobile numbers
//   text     — pass-through normalization
//
// Returns the extracted string value, or null if not confident enough.

// ── Hindi/Devanagari digit map ────────────────────────────────────────────────
const HINDI_DIGITS = { '०':'0','१':'1','२':'2','३':'3','४':'4',
  '५':'5','६':'6','७':'7','८':'8','९':'9' }

function _devanagariToAscii(str) {
  return str.replace(/[०-९]/g, d => HINDI_DIGITS[d] || d)
}

// ── Number word mappings ──────────────────────────────────────────────────────
const NUMBER_WORDS = {
  // English
  'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,'nine':9,
  'ten':10,'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
  'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
  'thirty':30,'forty':40,'fifty':50,'sixty':60,'seventy':70,'eighty':80,'ninety':90,
  'hundred':100,'thousand':1000,'lakh':100000,'lac':100000,'million':1000000,
  'dozen':12,'score':20,
  // Hindi
  'ek':1,'do':2,'teen':3,'char':4,'paanch':5,'chhe':6,'saat':7,'aath':8,'nau':9,
  'das':10,'bees':20,'tees':30,'chalis':40,'pachas':50,'saath':60,'sattar':70,
  'assi':80,'nabbe':90,'sau':100,'hazar':1000,'lakh':100000,
  // Common abbreviations
  'k':1000,
}

/**
 * Parse a human number expression to an integer.
 * Examples: "50", "around fifty", "लगभग 50", "2k", "1.5 lakh"
 */
function _parseNumber(str) {
  const s = _devanagariToAscii(str.toLowerCase().trim())

  // Plain integer / float (possibly with commas)
  const plain = s.replace(/,/g, '').match(/^[~≈≤≥]?\s*(\d+(?:\.\d+)?)(?:\s*(k|lakh|lac|thousand|hundred))?$/)
  if (plain) {
    let n = parseFloat(plain[1])
    const mult = NUMBER_WORDS[plain[2]] ?? 1
    return Math.round(n * mult)
  }

  // Remove approximation words
  const cleaned = s.replace(/\b(around|about|approximately|roughly|nearly|almost|just over|over|more than|less than|lagbhag|lagbhag|करीब|करीबन|तकरीबन|लगभग)\b/g, '').trim()

  // Try again after cleanup
  const again = cleaned.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k|lakh|lac|thousand)?/)
  if (again) {
    let n = parseFloat(again[1])
    const mult = NUMBER_WORDS[again[2]] ?? 1
    return Math.round(n * mult)
  }

  // Word-based: "fifty people", "do sau"
  const words = cleaned.split(/\s+/)
  let total = 0, running = 0
  for (const word of words) {
    const val = NUMBER_WORDS[word]
    if (val === undefined) continue
    if (val === 100) { running = (running || 1) * 100 }
    else if (val >= 1000) { total += (running || 1) * val; running = 0 }
    else running += val
  }
  total += running
  return total > 0 ? total : null
}

// ── Date extraction ───────────────────────────────────────────────────────────
const MONTHS = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,june:5,july:6,august:7,
  september:8,october:9,november:10,december:11,
  // Hindi
  'janvari':0,'pharavari':1,'march':2,'aprel':3,'maee':4,'joon':5,
  'julaee':6,'agast':7,'sitambar':8,'aktoobar':9,'navambar':10,'disambar':11,
}

const WEEKDAYS = { mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:0,
  monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0 }

function _toISO(d) {
  const yy = d.getFullYear().toString().padStart(4,'0')
  const mm = (d.getMonth()+1).toString().padStart(2,'0')
  const dd = d.getDate().toString().padStart(2,'0')
  return `${yy}-${mm}-${dd}`
}

function _parseDate(str) {
  const s     = str.toLowerCase().trim()
  const today = new Date(); today.setHours(0,0,0,0)
  const cloneDate = () => new Date(today)

  // Relative
  if (/\b(today|aaj|आज|abhi)\b/.test(s)) return _toISO(today)
  if (/\b(yesterday|kal|कल|beet.*din)\b/.test(s)) {
    const d = cloneDate(); d.setDate(d.getDate()-1); return _toISO(d)
  }
  if (/\b(tomorrow|kal|parso)\b/.test(s)) {
    const d = cloneDate(); d.setDate(d.getDate()+1); return _toISO(d)
  }
  if (/\b(day before yesterday|parson)\b/.test(s)) {
    const d = cloneDate(); d.setDate(d.getDate()-2); return _toISO(d)
  }

  // "last Monday", "next Friday"
  const weekdayM = s.match(/\b(last|next|is)\s+(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/)
  if (weekdayM) {
    const dir = weekdayM[1]
    const target = WEEKDAYS[weekdayM[2].slice(0, 3)]
    if (target !== undefined) {
      const d    = cloneDate()
      const diff = (target - d.getDay() + 7) % 7
      d.setDate(d.getDate() + (dir === 'last' ? diff - 7 : diff || (dir === 'next' ? 7 : 0)))
      return _toISO(d)
    }
  }

  // ISO YYYY-MM-DD
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (dmy) {
    const yr = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]
    return `${yr}-${String(dmy[2]).padStart(2,'0')}-${String(dmy[1]).padStart(2,'0')}`
  }

  // "10 Jan" / "10th January 2024"
  const monthName = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/)
  if (monthName) {
    const day  = monthName[1].padStart(2,'0')
    const mon  = String(MONTHS[monthName[2].slice(0,3)] + 1).padStart(2,'0')
    const year = monthName[3] || today.getFullYear().toString()
    return `${year}-${mon}-${day}`
  }

  return null
}

// ── Yes/No detection ──────────────────────────────────────────────────────────
const YES_TOKENS = new Set(['yes','yeah','ya','yep','yup','ok','okay','sure','fine','right',
  'correct','haan','han','ji','haa','haji','acha','accha','theek','ठीक','हाँ','हां','जी','ओके'])
const NO_TOKENS  = new Set(['no','nope','nah','not','nahi','nai','na','mat','रुको',
  'नहीं','न','nahi','nahin','नाही'])

function _parseYesNo(str) {
  const tokens = str.toLowerCase().trim().split(/\s+/)
  let yesCount = 0, noCount = 0
  for (const t of tokens) {
    if (YES_TOKENS.has(t)) yesCount++
    if (NO_TOKENS.has(t))  noCount++
  }
  if (yesCount > noCount && yesCount > 0) return 'yes'
  if (noCount > yesCount && noCount > 0)  return 'no'
  return null
}

// ── Phone extraction ──────────────────────────────────────────────────────────
function _parsePhone(str) {
  const digits = _devanagariToAscii(str).replace(/\D/g, '')
  // Indian mobile: starts 6-9, 10 digits; or with 91 prefix
  if (/^91([6-9]\d{9})$/.test(digits)) return digits.slice(2)
  if (/^[6-9]\d{9}$/.test(digits)) return digits
  // WhatsApp format
  const m = str.match(/(?:\+91|0)?([6-9]\d{9})/)
  if (m) return m[1]
  return null
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Extract a slot value from user text.
 * @param {string} text      — raw user message
 * @param {string} fieldName — logical field name (e.g. 'beneficiaries', 'date')
 * @param {string} fieldType — 'number' | 'date' | 'yesno' | 'phone' | 'text'
 * @returns {string|null}
 */
export function extract(text, fieldName, fieldType = 'text') {
  if (!text?.trim()) return null
  const s = _devanagariToAscii(text.trim())

  // Type override: if fieldName implies a type, use it
  const inferredType = (() => {
    if (fieldType && fieldType !== 'text') return fieldType
    const fn = (fieldName || '').toLowerCase()
    if (/beneficiar|count|number|total|how many|kitne/.test(fn)) return 'number'
    if (/date|when|din|samay|time/.test(fn)) return 'date'
    if (/confirm|agree|yes.or.no|approved/.test(fn)) return 'yesno'
    if (/phone|mobile|contact/.test(fn)) return 'phone'
    return 'text'
  })()

  switch (inferredType) {
    case 'number': {
      const n = _parseNumber(s)
      return n !== null && n >= 0 ? String(n) : null
    }
    case 'date': {
      return _parseDate(s)
    }
    case 'yesno': {
      return _parseYesNo(s)
    }
    case 'phone': {
      return _parsePhone(s)
    }
    default: {
      // Text: basic normalization, strip excess whitespace
      return s.replace(/\s+/g, ' ').trim() || null
    }
  }
}
