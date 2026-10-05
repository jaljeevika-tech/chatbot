import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { cubicBezier, motion, useReducedMotion } from 'motion/react'
import {
  ArrowRight, BarChart3, Check, X, ClipboardList, FileText, Languages, Lock,
  MapPin, MessageCircle, ShieldCheck, Sparkles, Sprout, Table, Users, Wallet,
} from 'lucide-react'
import BlurText from './landing/bits/BlurText'
import CountUp from './landing/bits/CountUp'
import ShinyText from './landing/bits/ShinyText'
import SpotlightCard from './landing/bits/SpotlightCard'
import StarBorder from './landing/bits/StarBorder'
import {
  HeroScene, PaperworkScene, CaptureSpot, OutcomesSpot, ReportSpot, CommunityScene,
  DirectorSpot, MandESpot, FinanceSpot, FieldSpot, TangleScene,
} from './landing/Illustrations'

// WebGL background pulls in ogl — load it only when it will actually render.
const Aurora = lazy(() => import('./landing/bits/Aurora'))

interface Props {
  onLogin: () => void
}

// FieldFlow 2026 palette (index.css @theme ff-*)
const C = {
  teal: '#0E3A46',
  tealDeep: '#082A33',
  purple: '#341272',
  cream: '#FBF9F4',
  sand: '#F2EDE2',
  line: '#E7E0D0',
  green: '#3F7D5C',
  mint: '#9FD3B4',
  amber: '#B8862E',
  ink: '#16313A',
  muted: '#5C7378',
}

const serif = { fontFamily: 'var(--font-serif)' }

// IBM Carbon expressive entrance curve (index.css --ease-expressive-in)
const EXPRESSIVE_IN = [0, 0, 0.3, 1] as const

// ── Content ──────────────────────────────────────────────────────────────────

const PAINS = [
  { stat: '30+', text: 'data formats a fieldworker fills every month', src: 'IDR' },
  { stat: '80+', text: 'WhatsApp groups one field coordinator juggles daily', src: 'IDR' },
  { stat: '₹ lakhs', text: 'what a single impact report can cost a nonprofit to produce', src: 'IDR' },
  { stat: '1 per funder', text: 'different report format for every donor and CSR partner', src: '' },
]

const PERSONAS = [
  { tab: 'Directors', who: 'Executive Directors & Founders', icon: Sprout, color: C.amber, Art: DirectorSpot,
    pain: 'Renewals depend on proof I can’t pull together fast enough.',
    gain: ['One live view of every project, district and donor', 'Funder reports drafted from real data in minutes', 'Board-ready impact decks without hiring a consultant'],
    uses: ['Impact dashboard', 'Content Hub', 'Board decks'] },
  { tab: 'M&E leads', who: 'M&E and Programme Leads', icon: BarChart3, color: C.green, Art: MandESpot,
    pain: 'I spend report season cleaning Excel instead of learning from it.',
    gain: ['MIS templates per project, filled straight from the field', 'Outputs and outcomes tracked against a live indicator matrix', 'Beneficiary journeys you can actually follow'],
    uses: ['MIS', 'Beneficiary profiles', 'Indicators'] },
  { tab: 'Finance', who: 'Finance & Admin Teams', icon: Wallet, color: C.purple, Art: FinanceSpot,
    pain: 'Advances, settlements and budgets live in five different spreadsheets.',
    gain: ['Advance → settlement → ledger, with Manager → Finance approval', 'Budget vs actual by project and donor', 'A full change log, ready for audit'],
    uses: ['Finance management', 'Budgets', 'HR & leave'] },
  { tab: 'Field teams', who: 'Field Staff & Coordinators', icon: MapPin, color: '#2F6F8F', Art: FieldSpot,
    pain: 'Too many formats, too many groups, too little time in the village.',
    gain: ['One phone app for visits, beneficiaries and attendance', 'Works in their own language', 'Keeps capturing when the network drops'],
    uses: ['Field app', 'GPS attendance', 'WhatsApp'] },
]

const PATCHWORK = [
  { from: 'A separate Excel MIS for every project', icon: Table, to: 'MIS & field data',
    desc: 'Per-project templates, bulk Excel upload and Google Sheets sync — start from formats you already use.' },
  { from: 'Beneficiary lists copied between sheets', icon: Users, to: 'Beneficiary profiles',
    desc: 'Every person’s trainings, interventions and projects in one record.' },
  { from: 'Impact numbers re-counted before every report', icon: BarChart3, to: 'Impact dashboard',
    desc: 'Theory of Change, SDGs and a live indicator matrix, always current.' },
  { from: 'Donor reports rewritten in Word each quarter', icon: Sparkles, to: 'Content Hub (AI)',
    desc: 'Donor, CSR and government reports drafted from your data, with sources.' },
  { from: 'Paper attendance registers and leave on chat', icon: ClipboardList, to: 'HR & attendance',
    desc: 'GPS check-in and two-level leave approval on an offline-ready app.' },
  { from: 'Advance requests chased over email', icon: Wallet, to: 'Finance management',
    desc: 'Advances, settlements, ledgers and budgets with built-in approvals.' },
  { from: 'Updates lost across dozens of WhatsApp groups', icon: MessageCircle, to: 'WhatsApp updates',
    desc: 'Send community and team updates from one place.' },
  { from: 'Translating every update by hand', icon: Languages, to: '12 Indian languages',
    desc: 'Reports and updates in the language each community speaks.' },
]

const FAQ = [
  { q: 'Will our field staff actually use it?',
    a: 'FieldFlow was built inside Jaljeevika for its own field teams — on everyday Android phones, in local languages, with capture that keeps working when the network drops.' },
  { q: 'We already have years of data in Excel. Do we start over?',
    a: 'No. Bring your existing MIS formats as templates, bulk-upload Excel, or keep syncing a Google Sheet while your team moves over.' },
  { q: 'Will the AI invent numbers in our donor reports?',
    a: 'Reports are generated from the data you recorded, and every figure is tied back to its source so your team can check it before anything goes to a funder.' },
  { q: 'Is our beneficiary data safe?',
    a: 'Each organisation’s data is isolated. Field, manager, finance and admin roles only see their own scope, and every admin action is logged.' },
  { q: 'What happens if we stop paying?',
    a: 'Your data is never deleted. After a short grace period the account becomes read-only — you can still view and export everything.' },
  { q: 'How long does it take to get started?',
    a: 'Every new organisation gets a 30-day free trial. Most teams start with one project’s MIS and add HR, finance and reporting as they go.' },
]

// ── Bits ─────────────────────────────────────────────────────────────────────

function useWideScreen() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

function Eyebrow({ children, light }: { children: string; light?: boolean }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.2em] mb-4"
      style={{ color: light ? '#9DBFC6' : C.green }}>
      {children}
    </p>
  )
}

function H2({ children, light }: { children: React.ReactNode; light?: boolean }) {
  return (
    <h2 className="text-3xl sm:text-5xl leading-tight" style={{ ...serif, color: light ? '#fff' : C.teal }}>
      {children}
    </h2>
  )
}

function Stat({ to, suffix = '', label, still }: { to: number; suffix?: string; label: string; still: boolean }) {
  return (
    <div>
      <div className="text-5xl tabular-nums text-white" style={serif}>
        {still ? to : <CountUp to={to} duration={1.6} />}{suffix}
      </div>
      <div className="mt-2 text-sm text-white/60">{label}</div>
    </div>
  )
}

function PrimaryCta({ onClick, children, still }: { onClick: () => void; children: string; still: boolean }) {
  return (
    <StarBorder as="button" onClick={onClick} color={still ? 'transparent' : '#E8C27A'} speed="5s"
      backgroundColor={C.amber} borderColor="rgba(255,255,255,0.18)" textColor="#fff" className="font-semibold">
      <span className="inline-flex items-center gap-2">{children} <ArrowRight className="w-4 h-4" /></span>
    </StarBorder>
  )
}

const field = 'w-full rounded-xl border px-3.5 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-[#3F7D5C]/40 bg-white'

function TrialDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setState('idle'); setError('')
    ref.current?.showModal()
  }, [open])

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setState('sending'); setError('')
    const body = Object.fromEntries(new FormData(e.currentTarget))
    try {
      const r = await fetch('/api/public/trial-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.')
      setState('done')
    } catch (err) {
      setError((err as Error).message); setState('idle')
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="trial-title"
      className="motion-dialog m-auto w-[min(32rem,calc(100vw-2rem))] rounded-3xl p-0 backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      style={{ background: C.cream, color: C.ink }}>
      <div className="p-7 sm:p-8">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h2 id="trial-title" className="text-2xl" style={{ ...serif, color: C.teal }}>
              Start your 30-day free trial
            </h2>
            <p className="mt-1 text-sm" style={{ color: C.muted }}>
              Tell us a little about your organisation and we’ll set up your workspace.
            </p>
          </div>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close"
            className="p-1.5 rounded-full hover:bg-black/5"><X className="w-5 h-5" /></button>
        </div>

        {state === 'done' ? (
          <div className="py-6 text-center">
            <Check className="w-10 h-10 mx-auto mb-3" style={{ color: C.green }} />
            <p className="text-lg" style={{ ...serif, color: C.teal }}>Thank you — we’ve got your request.</p>
            <p className="mt-2 text-sm" style={{ color: C.muted }}>We’ll be in touch by email to set up your workspace.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-3" style={{ borderColor: C.line }}>
            <input name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="text-sm">Your name<input name="name" required maxLength={120} autoComplete="name" className={field + ' mt-1'} style={{ borderColor: C.line }} /></label>
              <label className="text-sm">Organisation<input name="org_name" required maxLength={200} autoComplete="organization" className={field + ' mt-1'} style={{ borderColor: C.line }} /></label>
              <label className="text-sm">Work email<input name="email" type="email" required maxLength={200} autoComplete="email" className={field + ' mt-1'} style={{ borderColor: C.line }} /></label>
              <label className="text-sm">Phone <span style={{ color: C.muted }}>(optional)</span><input name="phone" type="tel" maxLength={30} autoComplete="tel" className={field + ' mt-1'} style={{ borderColor: C.line }} /></label>
              <label className="text-sm">Your role
                <select name="role" className={field + ' mt-1'} style={{ borderColor: C.line }} defaultValue="">
                  <option value="" disabled>Select…</option>
                  {['Executive Director / Founder', 'Programme / M&E lead', 'Finance / Admin', 'CSR / Foundation', 'Other'].map(o => <option key={o}>{o}</option>)}
                </select>
              </label>
              <label className="text-sm">Team size
                <select name="team_size" className={field + ' mt-1'} style={{ borderColor: C.line }} defaultValue="">
                  <option value="" disabled>Select…</option>
                  {['1–25', '26–100', '101–500', '500+'].map(o => <option key={o}>{o}</option>)}
                </select>
              </label>
            </div>
            <label className="text-sm">What should FieldFlow help with first? <span style={{ color: C.muted }}>(optional)</span>
              <textarea name="message" rows={3} maxLength={2000} className={field + ' mt-1 resize-none'} style={{ borderColor: C.line }} />
            </label>
            {error && <p role="alert" className="text-sm" style={{ color: '#B0473C' }}>{error}</p>}
            <button type="submit" disabled={state === 'sending'}
              className="mt-2 py-3 rounded-full font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              style={{ background: C.amber }}>
              {state === 'sending' ? 'Sending…' : 'Send request'}
            </button>
            <p className="text-xs text-center" style={{ color: C.muted }}>
              We only use these details to contact you about FieldFlow. <a href="/privacy" className="underline">Privacy policy</a>
            </p>
          </form>
        )}
      </div>
    </dialog>
  )
}

function PersonaSwitcher({ still }: { still: boolean }) {
  const [active, setActive] = useState(0)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const p = PERSONAS[active]

  function onKey(e: React.KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = (i + d + PERSONAS.length) % PERSONAS.length
    setActive(next)
    tabs.current[next]?.focus()
  }

  return (
    <div className="grid lg:grid-cols-[240px_1fr] gap-6">
      <div role="tablist" aria-label="Roles" aria-orientation="vertical"
        className="flex lg:flex-col gap-2 overflow-x-auto -mx-5 px-5 lg:mx-0 lg:px-0 pb-1">
        {PERSONAS.map((t, i) => {
          const on = i === active
          return (
            <button key={t.tab} ref={el => { tabs.current[i] = el }} role="tab" id={`persona-tab-${i}`}
              aria-selected={on} aria-controls="persona-panel" tabIndex={on ? 0 : -1}
              onClick={() => setActive(i)} onKeyDown={e => onKey(e, i)}
              className="shrink-0 flex items-center gap-3 text-left rounded-2xl px-4 py-3.5 border transition duration-[110ms] ease-productive"
              style={on
                ? { background: '#fff', borderColor: t.color, boxShadow: `inset 3px 0 0 ${t.color}` }
                : { background: 'transparent', borderColor: C.line }}>
              <t.icon className="w-5 h-5 shrink-0" style={{ color: on ? t.color : C.muted }} />
              <span className="font-medium whitespace-nowrap" style={{ color: on ? C.teal : C.muted }}>{t.tab}</span>
            </button>
          )
        })}
      </div>

      <motion.div key={active} id="persona-panel" role="tabpanel" aria-labelledby={`persona-tab-${active}`}
        initial={still ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EXPRESSIVE_IN }}
        className="grid md:grid-cols-[1fr_1.2fr] rounded-3xl overflow-hidden border bg-white" style={{ borderColor: C.line }}>
        <div className="p-8 flex items-center justify-center" style={{ background: p.color + '14', color: C.teal }}>
          <div className="w-full max-w-xs"><p.Art accent={p.color} /></div>
        </div>
        <div className="p-8 sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] mb-3" style={{ color: p.color }}>{p.who}</p>
          <p className="text-2xl sm:text-3xl leading-snug mb-7" style={{ ...serif, color: C.teal }}>“{p.pain}”</p>
          <p className="text-sm font-semibold mb-3" style={{ color: C.ink }}>With FieldFlow</p>
          <ul className="space-y-3 mb-8">
            {p.gain.map(g => (
              <li key={g} className="flex gap-3 text-[15px]" style={{ color: C.ink }}>
                <Check className="w-4 h-4 mt-1 shrink-0" style={{ color: p.color }} />{g}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {p.uses.map(u => (
              <span key={u} className="text-xs font-medium px-3 py-1.5 rounded-full border"
                style={{ borderColor: p.color + '55', color: p.color, background: p.color + '0D' }}>{u}</span>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function LandingPage({ onLogin }: Props) {
  const still = !!useReducedMotion()
  const wide = useWideScreen()
  const [trialOpen, setTrialOpen] = useState(false)
  const openTrial = () => setTrialOpen(true)

  const headline = 'Your funders want proof. Your team wants its evenings back.'

  return (
    <div className="min-h-screen font-sans" style={{ background: C.cream, color: C.ink }}>

      {/* ── Nav ───────────────────────────────────────────────────────── */}
      <nav className="absolute top-0 inset-x-0 z-20">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" className="w-8 h-8 rounded-lg object-contain" />
            <span className="font-semibold text-white text-lg">FieldFlow</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#who" className="hidden md:block text-sm text-white/70 hover:text-white">Who it’s for</a>
            <a href="#platform" className="hidden md:block text-sm text-white/70 hover:text-white">Platform</a>
            <a href="#faq" className="hidden md:block text-sm text-white/70 hover:text-white">FAQ</a>
            <button onClick={onLogin}
              className="text-sm font-semibold px-4 py-2 rounded-full bg-white/10 text-white border border-white/20 hover:bg-white/20 transition duration-[110ms] ease-productive">
              Sign in
            </button>
          </div>
        </div>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden" style={{ background: C.tealDeep }}>
        {!still && wide && (
          <div className="absolute inset-0 opacity-70" aria-hidden="true">
            <Suspense fallback={null}>
              <Aurora colorStops={['#3F7D5C', '#B8862E', '#5B2BB5']} amplitude={0.9} blend={0.6} speed={0.6} />
            </Suspense>
          </div>
        )}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: `linear-gradient(180deg, transparent 40%, ${C.tealDeep})` }} />

        <div className="relative max-w-5xl mx-auto px-5 pt-40 pb-24 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/15 bg-white/5 mb-8">
            <Sprout className="w-4 h-4" style={{ color: C.mint }} />
            <ShinyText text="Built inside a working NGO, for NGOs" disabled={still}
              color="#C9DDE1" shineColor="#ffffff" speed={3} className="text-sm" />
          </div>

          <div role="heading" aria-level={1}>
            {still ? (
              <p className="text-4xl sm:text-6xl leading-[1.08] text-white" style={serif}>{headline}</p>
            ) : (
              <BlurText text={headline} delay={70} animateBy="words" direction="top" easing={cubicBezier(...EXPRESSIVE_IN)}
                className="justify-center text-4xl sm:text-6xl leading-[1.08] text-white [font-family:var(--font-serif)]" />
            )}
          </div>

          <p className="max-w-2xl mx-auto mt-8 text-lg sm:text-xl leading-relaxed text-white/70">
            FieldFlow connects field data, MIS, beneficiaries, HR and finance in one place — so every
            donor and CSR report is drafted from data your team already collects, not rebuilt
            from scratch each quarter.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <PrimaryCta onClick={() => openTrial()} still={still}>Start your 30-day free trial</PrimaryCta>
            <a href="#who" className="text-white/80 hover:text-white font-medium underline-offset-4 hover:underline">
              See who it’s for
            </a>
          </div>
          <p className="mt-5 text-sm text-white/45">No card needed · Your data is never deleted · Works in 12 Indian languages</p>
          <div className="mt-16 max-w-4xl mx-auto text-white/85">
            <HeroScene />
          </div>
        </div>
      </section>

      {/* ── Pain ──────────────────────────────────────────────────────── */}
      <section className="px-5 py-24">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-[3fr_2fr] gap-10 items-end mb-12">
            <div>
              <Eyebrow>Sound familiar?</Eyebrow>
              <H2>The work is happening. The proof is buried in spreadsheets.</H2>
            </div>
            <div className="max-w-sm w-full mx-auto" style={{ color: C.ink }}>
              <PaperworkScene />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-px rounded-3xl overflow-hidden border"
            style={{ background: C.line, borderColor: C.line }}>
            {PAINS.map(p => (
              <div key={p.text} className="p-7" style={{ background: C.cream }}>
                <div className="text-4xl mb-3" style={{ ...serif, color: C.amber }}>{p.stat}</div>
                <p className="text-[15px] leading-relaxed" style={{ color: C.ink }}>{p.text}</p>
                {p.src && <p className="mt-3 text-xs" style={{ color: C.muted }}>Source: India Development Review</p>}
              </div>
            ))}
          </div>
          <p className="mt-10 max-w-3xl text-lg leading-relaxed" style={{ color: C.muted }}>
            Every hour a coordinator spends re-typing a format is an hour not spent in the village.
            And every report pieced together at the last minute is one a funder has less reason to trust.
          </p>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section className="px-5 py-24" style={{ background: C.sand }}>
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl mb-14">
            <Eyebrow>How FieldFlow works</Eyebrow>
            <H2>Collect once. Report to everyone.</H2>
          </div>
          <div className="grid md:grid-cols-3 gap-5">
            {[
              { n: '01', Art: CaptureSpot, title: 'Capture in the field',
                desc: 'Staff log visits, beneficiaries, MIS activities and attendance from their phones, in their language — even offline.' },
              { n: '02', Art: OutcomesSpot, title: 'See outcomes, live',
                desc: 'Records roll up into beneficiary profiles, project progress and your impact framework — no month-end consolidation.' },
              { n: '03', Art: ReportSpot, title: 'Report with confidence',
                desc: 'Draft donor updates, CSR progress reports and government MIS in minutes — every number traceable to its source.' },
            ].map(s => (
              <SpotlightCard key={s.n} spotlightColor="rgba(63, 125, 92, 0.18)"
                className="p-8 bg-white border border-[#E7E0D0]">
                <div className="flex items-start justify-between mb-6">
                  <div className="w-44" style={{ color: C.teal }}><s.Art /></div>
                  <span className="text-sm tabular-nums" style={{ ...serif, color: C.amber }}>{s.n}</span>
                </div>
                <h3 className="text-2xl mb-3" style={{ ...serif, color: C.teal }}>{s.title}</h3>
                <p className="text-[15px] leading-relaxed" style={{ color: C.muted }}>{s.desc}</p>
              </SpotlightCard>
            ))}
          </div>
        </div>
      </section>

      {/* ── Who it's for ───────────────────────────────────────────────── */}
      <section id="who" className="px-5 py-24">
        <div className="max-w-6xl mx-auto">
          <div className="max-w-2xl mb-10">
            <Eyebrow>Who it’s for</Eyebrow>
            <H2>One platform. Four people who stop chasing data.</H2>
          </div>
          <PersonaSwitcher still={still} />
        </div>
      </section>

      {/* ── Replace the patchwork ──────────────────────────────────────── */}
      <section id="platform" className="px-5 py-24" style={{ background: C.teal }}>
        <div className="max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-10 items-end mb-14">
            <div>
              <Eyebrow light>Replace the patchwork</Eyebrow>
              <H2 light>Eight tools that don’t talk to each other. One that does.</H2>
            </div>
            <div className="text-white/80"><TangleScene /></div>
          </div>
          <div className="hidden md:grid grid-cols-[1fr_auto_1.4fr] gap-6 px-6 pb-3 text-xs uppercase tracking-[0.2em] text-white/40">
            <span>Instead of</span><span className="w-5" /><span>Use FieldFlow</span>
          </div>
          <ul className="rounded-3xl border border-white/10 divide-y divide-white/10 overflow-hidden">
            {PATCHWORK.map(r => (
              <li key={r.to} className="group grid md:grid-cols-[1fr_auto_1.4fr] gap-3 md:gap-6 items-center px-6 py-5 transition-colors duration-[110ms] ease-productive hover:bg-white/[0.04]">
                <span className="flex items-center gap-3 text-white/45">
                  <X className="w-4 h-4 shrink-0" style={{ color: '#D98B7F' }} />
                  <span className="line-through decoration-white/25">{r.from}</span>
                </span>
                <ArrowRight className="hidden md:block w-5 h-5 text-white/30 transition duration-[150ms] ease-productive group-hover:translate-x-1 group-hover:text-white/70" />
                <span className="flex items-start gap-4">
                  <span className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center bg-white/[0.06] border border-white/10">
                    <r.icon className="w-5 h-5" style={{ color: C.mint }} />
                  </span>
                  <span>
                    <span className="block text-lg text-white" style={serif}>{r.to}</span>
                    <span className="block text-sm leading-relaxed text-white/60">{r.desc}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Proof / origin ─────────────────────────────────────────────── */}
      <section className="px-5 py-24" style={{ background: C.tealDeep }}>
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-14 items-center">
          <div>
            <Eyebrow light>Why you can trust it</Eyebrow>
            <H2 light>Not built for NGOs. Built <em>by</em> one.</H2>
            <p className="mt-6 text-lg leading-relaxed text-white/65">
              FieldFlow began as Jaljeevika’s own system for running field programmes, reporting to
              funders and paying field teams on time. Every module exists because a programme,
              M&amp;E or finance team needed it on a real deadline.
            </p>
            <div className="mt-10 max-w-md text-white/85">
              <CommunityScene />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-10">
            <Stat to={12} label="Indian languages" still={still} />
            <Stat to={17} label="Impact indicators tracked live" still={still} />
            <Stat to={27} suffix="+" label="Report & story formats" still={still} />
            <Stat to={30} label="Day free trial, no card" still={still} />
          </div>
        </div>
      </section>

      {/* ── Trust ──────────────────────────────────────────────────────── */}
      <section className="px-5 py-20" style={{ background: C.sand }}>
        <div className="max-w-6xl mx-auto grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            { icon: Lock, title: 'Role-based access', desc: 'Field, manager, finance and admin each see only their scope.' },
            { icon: ShieldCheck, title: 'Isolated per organisation', desc: 'Your data never mixes with another NGO’s.' },
            { icon: FileText, title: 'Source for every number', desc: 'Reports cite the records behind each figure.' },
            { icon: Sprout, title: 'Never held hostage', desc: 'Export anytime. Data is never deleted, even if you stop paying.' },
          ].map(t => (
            <div key={t.title}>
              <t.icon className="w-5 h-5 mb-3" style={{ color: C.green }} />
              <h3 className="font-semibold mb-1" style={{ color: C.teal }}>{t.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: C.muted }}>{t.desc}</p>
            </div>
          ))}
        </div>
        <p className="max-w-6xl mx-auto mt-10 text-sm" style={{ color: C.muted }}>
          Read our <a href="/privacy" className="underline font-medium" style={{ color: C.green }}>privacy &amp; data protection policy</a>.
        </p>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <section id="faq" className="px-5 py-24">
        <div className="max-w-3xl mx-auto">
          <Eyebrow>Questions directors ask us</Eyebrow>
          <H2>Before you decide.</H2>
          <div className="mt-10 divide-y border-y" style={{ borderColor: C.line }}>
            {FAQ.map(f => (
              <details key={f.q} className="group py-5" style={{ borderColor: C.line }}>
                <summary className="flex justify-between items-center cursor-pointer list-none text-lg font-medium" style={{ color: C.teal }}>
                  {f.q}
                  <span className="ml-4 text-2xl transition-transform duration-[150ms] ease-productive group-open:rotate-45" style={{ color: C.amber }}>+</span>
                </summary>
                <p className="mt-3 leading-relaxed" style={{ color: C.muted }}>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section className="px-5 py-28 text-center" style={{ background: C.tealDeep }}>
        <H2 light>Spend report season in the field, not in Excel.</H2>
        <p className="max-w-xl mx-auto mt-5 text-lg text-white/60">
          Start with one project. See your first funder report drafted from your own data this week.
        </p>
        <div className="mt-10">
          <PrimaryCta onClick={() => openTrial()} still={still}>Start your 30-day free trial</PrimaryCta>
        </div>
      </section>

      <TrialDialog open={trialOpen} onClose={() => setTrialOpen(false)} />

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="px-5 py-8" style={{ background: C.tealDeep, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-white/50">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="" className="w-6 h-6 rounded object-contain" />
            <span className="font-semibold text-white">FieldFlow</span>
          </div>
          <p className="flex items-center gap-2">
            <span>© 2026 Jaljeevika · Built by TATWA</span>
            <span aria-hidden="true">·</span>
            <a href="/privacy" className="underline text-white/60 hover:text-white">Privacy &amp; Data Protection</a>
          </p>
        </div>
      </footer>
    </div>
  )
}
