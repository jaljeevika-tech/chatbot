// Line-style landing illustrations, after the IBM Developer illustration guide:
// one stroke colour (currentColor) on a flat background, plus a few flat colour
// highlights. No gradients or shading. Decorative only — text carries meaning.
// Strokes draw themselves when scrolled into view (IBM/Carbon expressive motion;
// CSS in index.css .line-draw). Skipped under prefers-reduced-motion.

import { useEffect, useRef, useState, type ReactNode } from 'react'

const svgProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className: 'w-full h-auto',
}

function Svg({ viewBox, children }: { viewBox: string; children: ReactNode }) {
  const ref = useRef<SVGSVGElement>(null)
  const [stage, setStage] = useState<'static' | 'armed' | 'drawn'>('static')
  useEffect(() => {
    const svg = ref.current
    if (!svg || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let i = 0
    svg.querySelectorAll<SVGElement>('path, circle, rect, ellipse').forEach(el => {
      if (el.getAttribute('stroke') === 'none' || el.hasAttribute('stroke-dasharray')) return
      el.setAttribute('pathLength', '1')
      el.classList.add('ld')
      el.style.animationDelay = `${Math.min(i++ * 35, 600)}ms`
    })
    setStage('armed')
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setStage('drawn'); io.disconnect() }
    }, { threshold: 0.3 })
    io.observe(svg)
    return () => io.disconnect()
  }, [])
  const cls = `${svgProps.className}${stage === 'static' ? '' : ' line-draw'}${stage === 'drawn' ? ' is-drawn' : ''}`
  return <svg ref={ref} viewBox={viewBox} {...svgProps} className={cls}>{children}</svg>
}

/** Standing figure; (x, y) is the head centre. */
function Person({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={8} />
      <path d={`M${x - 13} ${y + 46} V${y + 26} a13 13 0 0 1 26 0 V${y + 46} M${x - 6} ${y + 46} v26 M${x + 6} ${y + 46} v26`} />
    </g>
  )
}

/** Seated figure; (x, y) is the head centre. */
function Seated({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={8} />
      <path d={`M${x - 13} ${y + 40} V${y + 26} a13 13 0 0 1 26 0 V${y + 40} M${x - 18} ${y + 40} h36`} />
    </g>
  )
}

function Hut({ x, w = 70 }: { x: number; w?: number }) {
  const g = 230
  return <path d={`M${x} ${g} V${g - 50} H${x + w} V${g} M${x - 10} ${g - 48} L${x + w / 2} ${g - 85} L${x + w + 10} ${g - 48} M${x + w / 2 - 7} ${g} v-26 h14 v26`} />
}

function Tree({ x, r = 32 }: { x: number; r?: number }) {
  return (
    <g>
      <path d={`M${x} 230 V${200 - r} M${x} ${215 - r} l-12 -12 M${x} ${205 - r} l12 -10`} />
      <circle cx={x} cy={185 - r * 1.2} r={r} />
    </g>
  )
}

/** Hero: a field worker in a village sends a visit record to a live dashboard. */
export function HeroScene({ accent = '#E8C27A', mint = '#9FD3B4' }: { accent?: string; mint?: string }) {
  return (
    <Svg viewBox="0 0 800 260">
      {/* flat highlights first, lines on top */}
      <circle cx={712} cy={52} r={20} fill={accent} stroke="none" />
      <rect x={347} y={160} width={12} height={16} rx={1} fill={accent} stroke="none" />
      <rect x={640} y={168} width={18} height={36} fill={mint} stroke="none" />

      <path d="M20 230 H780" />
      <Hut x={70} />
      <Hut x={175} w={56} />
      <Tree x={275} />
      <Person x={330} y={140} />
      {/* arm + phone */}
      <path d="M343 172 l8 -6" />
      <rect x={345} y={156} width={16} height={24} rx={3} />
      <path d="M372 152 a16 16 0 0 1 0 28 M380 145 a26 26 0 0 1 0 42" />
      {/* data travelling to the dashboard */}
      <path d="M400 168 C 460 90, 520 90, 566 128" strokeDasharray="6 9" />
      <path d="M558 120 l8 8 l-11 3" />

      {/* dashboard */}
      <rect x={570} y={110} width={180} height={110} rx={8} />
      <path d="M570 128 H750 M582 120 h4 M592 120 h4 M640 230 v-10 M680 230 v-10 M625 230 h70" />
      <path d="M590 204 v-20 M612 204 v-34 M640 204 v-36 M676 204 v-48" strokeWidth={10} strokeLinecap="butt" />
      <path d="M696 178 l14 -14 l12 8 l18 -26" />
      <circle cx={740} cy={146} r={3} />

      {/* clouds */}
      <path d="M90 60 h50 a12 12 0 0 0 -14 -16 a16 16 0 0 0 -28 4 a10 10 0 0 0 -8 12 Z" />
      <path d="M440 40 h40 a10 10 0 0 0 -12 -13 a13 13 0 0 0 -22 3 a8 8 0 0 0 -6 10 Z" />
    </Svg>
  )
}

/** Pain: a coordinator buried under formats and chat groups. */
export function PaperworkScene({ accent = '#B8862E' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 360 240">
      {/* chat bubble highlights */}
      <rect x={232} y={22} width={46} height={26} rx={8} fill={accent} stroke="none" opacity={0.85} />
      <rect x={286} y={60} width={46} height={26} rx={8} fill={accent} stroke="none" opacity={0.55} />
      <rect x={240} y={98} width={40} height={24} rx={8} fill={accent} stroke="none" opacity={0.35} />

      {/* desk */}
      <path d="M20 200 H340 M50 200 v30 M310 200 v30" />
      {/* paper stack */}
      {[0, 1, 2, 3, 4, 5].map(i => (
        <rect key={i} x={40 + (i % 2) * 4} y={170 - i * 16} width={90} height={16} rx={2} />
      ))}
      <path d="M58 80 h40 M58 88 h28" />
      <rect x={46} y={66} width={70} height={30} rx={2} transform="rotate(-8 81 81)" />
      {/* person at desk, head in hand */}
      <circle cx={190} cy={128} r={10} />
      <path d="M170 200 V168 a20 20 0 0 1 40 0 V200 M206 172 l-10 -26" />
      {/* laptop with spreadsheet */}
      <path d="M218 200 h80 l-8 -46 h-64 Z M234 166 h46 M232 176 h50 M230 186 h54 M252 158 v34 M268 158 v34" />
      {/* chat bubbles outlines */}
      <rect x={228} y={18} width={46} height={26} rx={8} />
      <path d="M238 44 l-4 8 l10 -8" />
      <rect x={282} y={56} width={46} height={26} rx={8} />
      <path d="M318 82 l4 8 l-10 -8" />
      <rect x={236} y={94} width={40} height={24} rx={8} />
      <path d="M240 31 h26 M294 69 h22 M246 106 h20" />
    </Svg>
  )
}

/** Step 1: capture on the phone, in the field. */
export function CaptureSpot({ accent = '#3F7D5C' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 200 120">
      <rect x={82} y={18} width={36} height={58} rx={3} fill={accent} stroke="none" opacity={0.18} />
      <path d="M10 110 H190" />
      <path d="M20 110 V86 H56 V110 M14 87 L38 66 L62 87" />
      <circle cx={160} cy={62} r={18} />
      <path d="M160 110 V80" />
      <rect x={78} y={14} width={44} height={84} rx={7} />
      <path d="M92 22 h16" />
      <path d="M100 66 c-9 -10 -12 -15 -12 -20 a12 12 0 0 1 24 0 c0 5 -3 10 -12 20 Z" />
      <circle cx={100} cy={46} r={4} />
      <path d="M90 82 h20" />
    </Svg>
  )
}

/** Step 2: outcomes rising on a live chart. */
export function OutcomesSpot({ accent = '#3F7D5C' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 200 120">
      <rect x={124} y={34} width={18} height={70} fill={accent} stroke="none" opacity={0.25} />
      <path d="M30 104 H180 M30 104 V14" />
      <rect x={46} y={78} width={18} height={26} />
      <rect x={85} y={58} width={18} height={46} />
      <rect x={124} y={34} width={18} height={70} />
      <path d="M44 62 L94 40 L132 20 L168 12 M156 10 l12 2 l-4 11" />
      <circle cx={94} cy={40} r={3} />
      <circle cx={132} cy={20} r={3} />
    </Svg>
  )
}

/** Step 3: a verified report, ready for the funder. */
export function ReportSpot({ accent = '#B8862E' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 200 120">
      <circle cx={128} cy={84} r={18} fill={accent} stroke="none" opacity={0.3} />
      <path d="M58 10 H118 L138 30 V110 H58 Z M118 10 V30 H138" />
      <path d="M70 40 h40 M70 52 h56 M70 64 h50 M70 76 h30" />
      <circle cx={128} cy={84} r={18} />
      <path d="M119 84 l6 6 l12 -12" />
      <path d="M150 50 l22 -8 M154 64 h24 M150 78 l22 8" strokeDasharray="3 6" />
    </Svg>
  )
}

/** Origin: a community meeting under the village tree. */
export function CommunityScene({ mint = '#9FD3B4', accent = '#E8C27A' }: { mint?: string; accent?: string }) {
  return (
    <Svg viewBox="0 0 420 260">
      <circle cx={210} cy={74} r={56} fill={mint} stroke="none" opacity={0.25} />
      <rect x={316} y={150} width={16} height={22} fill={accent} stroke="none" />

      <path d="M20 240 H400" />
      {/* big tree */}
      <path d="M210 240 V120 M210 150 l-24 -22 M210 138 l22 -20" />
      <circle cx={210} cy={74} r={56} />
      <path d="M180 64 a20 20 0 0 1 22 -18 M222 90 a16 16 0 0 0 18 -14" />
      {/* circle of people */}
      <Seated x={70} y={186} />
      <Seated x={130} y={196} />
      <Seated x={290} y={196} />
      <Person x={250} y={150} />
      {/* chart board on easel */}
      <rect x={300} y={124} width={70} height={56} rx={3} />
      <path d="M310 172 v-8 M324 172 v-16 M338 172 v-12 M352 172 v-24 M310 180 l-10 60 M360 180 l10 60" />
      <path d="M263 176 l30 -14" />
    </Svg>
  )
}

/** Persona: director presenting results to a board. */
export function DirectorSpot({ accent = '#B8862E' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 240 180">
      <rect x={110} y={30} width={110} height={74} rx={4} fill={accent} stroke="none" opacity={0.18} />
      <path d="M10 166 H230" />
      <rect x={110} y={30} width={110} height={74} rx={4} />
      <path d="M150 104 v62 M180 104 v62 M140 166 h50" />
      <path d="M124 90 L150 72 L172 80 L206 46 M196 44 h10 v10" />
      <Person x={64} y={86} />
      <path d="M77 112 L108 74" />
      <path d="M22 50 a10 10 0 0 1 20 0 M30 30 v6" />
    </Svg>
  )
}

/** Persona: M&E lead examining the data. */
export function MandESpot({ accent = '#3F7D5C' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 240 180">
      <circle cx={150} cy={86} r={30} fill={accent} stroke="none" opacity={0.2} />
      <path d="M10 166 H230" />
      <rect x={60} y={20} width={120} height={140} rx={4} />
      <path d="M60 44 H180 M100 20 V160 M140 20 V160 M60 68 H180 M60 92 H180 M60 116 H180 M60 140 H180" opacity={0.5} />
      <circle cx={150} cy={86} r={30} />
      <path d="M171 107 L200 136" strokeWidth={5} />
      <path d="M134 96 l10 -10 l8 6 l14 -16" />
    </Svg>
  )
}

/** Persona: finance — ledger, coins, approvals. */
export function FinanceSpot({ accent = '#341272' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 240 180">
      <rect x={30} y={40} width={110} height={110} rx={4} fill={accent} stroke="none" opacity={0.12} />
      <path d="M10 166 H230" />
      <rect x={30} y={40} width={110} height={110} rx={4} />
      <path d="M50 40 V150 M62 64 h60 M62 82 h44 M62 100 h56 M62 118 h36" />
      <path d="M110 130 l8 8 l14 -16" />
      {[0, 1, 2, 3].map(i => <ellipse key={i} cx={186} cy={150 - i * 12} rx={24} ry={7} />)}
      <path d="M162 150 v-36 M210 150 v-36" />
      <path d="M178 84 h16 M178 92 h16 M184 84 c10 0 10 8 0 8 l10 12" />
      <circle cx={186} cy={94} r={18} />
    </Svg>
  )
}

/** Persona: field worker with phone in the village. */
export function FieldSpot({ accent = '#2F6F8F' }: { accent?: string }) {
  return (
    <Svg viewBox="0 0 240 180">
      <rect x={128} y={84} width={14} height={20} rx={2} fill={accent} stroke="none" opacity={0.6} />
      <path d="M10 166 H230" />
      <path d="M20 166 V126 H76 V166 M10 128 L48 96 L86 128 M42 166 v-20 h12 v20" />
      <circle cx={196} cy={90} r={26} />
      <path d="M196 166 V116 M196 132 l-10 -8" />
      <Person x={112} y={68} />
      <path d="M125 100 l6 -6" />
      <rect x={126} y={80} width={18} height={26} rx={3} />
      <path d="M152 78 a14 14 0 0 1 0 24 M160 72 a24 24 0 0 1 0 36" />
    </Svg>
  )
}

/** Patchwork: tangled tools pulled into one clean thread. */
export function TangleScene({ mint = '#9FD3B4', accent = '#E8C27A' }: { mint?: string; accent?: string }) {
  return (
    <Svg viewBox="0 0 640 140">
      <rect x={520} y={40} width={90} height={60} rx={10} fill={mint} stroke="none" opacity={0.25} />
      <circle cx={70} cy={40} r={6} fill={accent} stroke="none" />
      <circle cx={150} cy={110} r={6} fill={accent} stroke="none" />
      <path d="M30 70 C 60 10, 110 120, 140 60 S 60 20, 90 90 S 200 120, 170 40 S 120 30, 160 100 S 250 20, 230 70" />
      <path d="M50 100 C 90 130, 120 20, 190 70 S 230 110, 260 70" />
      <path d="M40 30 C 100 60, 170 0, 210 50" />
      <path d="M260 70 H500" />
      <path d="M492 62 l8 8 l-8 8" />
      <rect x={520} y={40} width={90} height={60} rx={10} />
      <path d="M538 60 h54 M538 72 h40 M538 84 h48" />
    </Svg>
  )
}
