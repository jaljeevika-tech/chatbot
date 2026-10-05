// Sector-tuned prompt overlays. Each sector has its own vocabulary, units, donor
// expectations and evidence norms; overlays are appended to the base prompt (never
// replace it) so its anti-fabrication and citation rules stay.
//
// Usage in a route handler:
//   import { sectorOverlay } from '../lib/prompts/sectorPrompts.js'
//   const base = await getOrgPrompt(orgId, 'report_field_system', DEFAULT_SYS)
//   const sectorTag = orgMeta?.sector || 'general'
//   const sys = base + '\n\n' + sectorOverlay(sectorTag, 'report_field_system')
//
// Sectors recognized:  fisheries · livelihoods · education · health ·
//                       women-collective · agriculture · general
//
// Prompt IDs covered:   report_field_system · rw_draft_system ·
//                       rw_refine_system · rw_reflect_system · rw_learn_system ·
//                       ai_assistant_system · notebook_chat_system ·
//                       notebook_audio_system · notebook_study_system ·
//                       notebook_slides_system · wa_nlu_fallback

const SECTOR_VOCAB = {
  fisheries: {
    nouns: 'pond, hatchery, fingerling, brood-stock, FCR (feed conversion ratio), DO (dissolved oxygen), aerator, harvest, marketable size, post-harvest loss, cooperative, fish-seed, mortality rate, water quality, polyculture, IMC (Indian Major Carp)',
    units: 'kilogram (kg), hectare (ha), parts-per-million (ppm), days-to-harvest',
    activities: 'pond construction, water testing, feed distribution, stocking, training on hygiene, market linkage, value-chain workshop',
    indicators: 'productivity (kg/ha/year), survival rate, FCR, income per fisher, women members in cooperative',
    typical_donors: 'NFDB, PMMSY, World Bank, KOICA, BMZ',
    safeguarding: 'avoid disclosing pond locations of small-holders publicly (theft risk). Aggregate to village level.',
  },
  livelihoods: {
    nouns: 'micro-enterprise, livelihood diversification, value-chain, market linkage, SHG (self-help group), federation, working capital, savings, credit, repayment, livelihood asset, skill training, placement, income diversification',
    units: 'rupees (₹), days-of-work, members, units produced, monthly income',
    activities: 'skill training, enterprise establishment, market linkage, credit linkage, financial-literacy session, exposure visit',
    indicators: 'average monthly income, % HH with diversified income, repayment rate, number of enterprises operational after 12 months',
    typical_donors: 'NABARD, NRLM, DAY-NRLM, foundations, CSR',
    safeguarding: 'never publish individual SHG-member savings balances. Aggregate to group level.',
  },
  education: {
    nouns: 'enrollment, retention, dropout, learning outcome, foundational literacy, foundational numeracy, FLN, NIPUN, mid-day-meal, teacher training, SMC (School Management Committee), parent-teacher meeting, library corner, TLM (teaching-learning material), bridge course, multi-grade, government school, anganwadi',
    units: 'children, days-attended, learning-level (FLN bands), grade-level competency',
    activities: 'remedial class, teacher training, parent engagement, library setup, learning assessment, enrollment drive',
    indicators: 'enrollment rate, retention rate, learning-level distribution (ASER bands), % at grade-level competency, attendance %, teacher trained count',
    typical_donors: 'CSR, SDG-4 aligned funds, Sarva Shiksha Abhiyan partnerships',
    safeguarding: 'NEVER name children publicly. Photos with faces require parent consent on file. Refer to children by initials or as "Child A" in any output that may be shared externally.',
  },
  health: {
    nouns: 'ANC (antenatal care), PNC (postnatal care), institutional delivery, immunisation, ANM (auxiliary nurse midwife), ASHA, anganwadi worker, MAMTA, MMR, IMR, anaemia, IFA, deworming, RKSK, adolescent health, mental-health, NCD screening, JSY, PMSMA',
    units: 'patients, doses administered, screenings, ANC visits, kg (weight), cm (height), Hb (g/dl), BMI',
    activities: 'ANC camp, vaccination, screening, counselling, referral, awareness session, government-system linkage',
    indicators: 'ANC4 coverage, institutional-delivery rate, full immunisation rate, anaemia prevalence, referrals completed',
    typical_donors: 'NHM, USAID, GAVI, Bill & Melinda Gates Foundation, JSY-linked',
    safeguarding: 'health data is HIGHLY sensitive. Never expose patient names, conditions, or HIV/TB status. All extraction must aggregate to village/age-band level. Use coded IDs for case studies.',
  },
  'women-collective': {
    nouns: 'SHG (self-help group), CLF (cluster level federation), VO (village organisation), sangha, didi, savings, inter-loan, federation, livelihood, gender training, POSH, domestic violence, decision-making, asset ownership',
    units: 'members, ₹ savings, ₹ loans, meetings held, federations',
    activities: 'group formation, capacity building, federation setup, financial-literacy training, gender-sensitisation session',
    indicators: 'active members, savings per member, repayment rate, % women in panchayat / decision-making roles, # POSH committees formed',
    typical_donors: 'NRLM, DAY-NRLM, foundations, multilateral',
    safeguarding: 'NEVER disclose individual member savings. NEVER publish details of domestic-violence cases or POSH complaints. Aggregate everything.',
  },
  agriculture: {
    nouns: 'kharif, rabi, zaid, FPO (farmer producer organisation), KVK, soil-health card, FYM, drip, sprinkler, MSP, mandi, e-NAM, organic certification, krishi vigyan, demonstration plot, seed-bank, integrated pest management (IPM)',
    units: 'acre, hectare, quintal, kg/ha (yield), ₹/quintal, days-to-maturity',
    activities: 'soil testing, demo plot, training, input supply, market linkage, FPO formation, irrigation infrastructure',
    indicators: 'yield (kg/ha), # FPO members, % adopting recommended practice, income/acre, water-use efficiency',
    typical_donors: 'NABARD, PKVY, RKVY, World Bank, ATMA',
    safeguarding: 'avoid publishing individual farmer income — aggregate to FPO or village level. Don\'t expose land-holding details of small / marginal farmers.',
  },
  general: {
    nouns: 'beneficiary, activity, output, outcome, impact, community, mobilisation, stakeholder, capacity-building',
    units: 'people, sessions, materials distributed, ₹',
    activities: 'training, awareness, capacity-building, infrastructure, advocacy',
    indicators: 'beneficiaries reached, activities completed, satisfaction score',
    typical_donors: 'mixed',
    safeguarding: 'follow general PII rules — mask phone numbers, get consent for photos.',
  },
}

// Field-report extraction overlay — sharpens slot extraction for sector terms
function _fieldReportOverlay(sector) {
  const v = SECTOR_VOCAB[sector] || SECTOR_VOCAB.general
  return `SECTOR CONTEXT — ${sector.toUpperCase()}:
When the worker mentions any of these terms, recognize them as sector vocabulary and preserve them verbatim in your extraction. Do NOT translate them to generic English equivalents.

Vocabulary you may see: ${v.nouns}.
Units commonly used: ${v.units}.
Typical activities: ${v.activities}.
Sector-specific indicators to extract when mentioned: ${v.indicators}.

Safeguarding: ${v.safeguarding}`
}

// Report-writer overlay — guides narrative tone + donor-aware structure
function _reportWriterOverlay(sector) {
  const v = SECTOR_VOCAB[sector] || SECTOR_VOCAB.general
  return `SECTOR CONTEXT — ${sector.toUpperCase()}:

VOICE & TONE for this sector:
- Use the vocabulary the sector expects (${v.nouns.split(',').slice(0,8).join(',')}, etc.) — donors reading this expect this register, not generic NGO-speak.
- Lead with NUMBERS-IN-CONTEXT (e.g., "Productivity rose from 2.1 to 2.8 t/ha across 47 ponds" — not "We saw improvement").
- Use past tense throughout. Report what happened, never what was planned.

EXPECTED INDICATORS for this sector (cite by name in the report):
${v.indicators}

DONOR CONVENTIONS for this sector (${v.typical_donors}):
- These donors expect: indicator-level tables, photographic evidence per activity, named locations, time-series comparisons.

SAFEGUARDING (NON-NEGOTIABLE):
${v.safeguarding}`
}

// AI-assistant overlay — for the general "ask FieldFlow" chat surface
function _aiAssistantOverlay(sector) {
  const v = SECTOR_VOCAB[sector] || SECTOR_VOCAB.general
  return `The user works in the ${sector} sector. When answering questions, prefer terminology and units from this domain: ${v.units}. Common indicators they may ask about: ${v.indicators}. If they ask about a metric you don't have data for, say so plainly — don't substitute a different metric.`
}

// Notebook-chat overlay — for RAG over project docs
function _notebookOverlay(sector) {
  const v = SECTOR_VOCAB[sector] || SECTOR_VOCAB.general
  return `The user works in the ${sector} sector. When citing sources, name the document and page. When summarising, use the sector's standard vocabulary (${v.nouns.split(',').slice(0,6).join(', ')}, etc.). If a source contradicts another source, say so — do not silently average them.`
}

// WhatsApp NLU fallback — when no flow keyword matches incoming message
function _waNluOverlay(sector) {
  const v = SECTOR_VOCAB[sector] || SECTOR_VOCAB.general
  return `This NGO works in ${sector}. Common topics community members may message about: ${v.activities}. If you can't recognise intent, ask ONE specific clarifying question — never give a generic "I didn't understand" reply.`
}

const OVERLAY_BUILDERS = {
  report_field_system: _fieldReportOverlay,
  rw_draft_system: _reportWriterOverlay,
  rw_refine_system: _reportWriterOverlay,
  rw_reflect_system: _reportWriterOverlay,
  rw_learn_system: _reportWriterOverlay,
  ai_assistant_system: _aiAssistantOverlay,
  notebook_chat_system: _notebookOverlay,
  notebook_audio_system: _notebookOverlay,
  notebook_video_system: _notebookOverlay,
  notebook_study_system: _notebookOverlay,
  notebook_slides_system: _notebookOverlay,
  wa_nlu_fallback: _waNluOverlay,
}

/** Overlay text for a sector + prompt ID; '' when either is unknown, so callers can always concatenate. */
export function sectorOverlay(sector, promptId) {
  const builder = OVERLAY_BUILDERS[promptId]
  if (!builder) return ''
  const sectorKey = (sector || 'general').toLowerCase().trim()
  return builder(sectorKey)
}

export { SECTOR_VOCAB }
