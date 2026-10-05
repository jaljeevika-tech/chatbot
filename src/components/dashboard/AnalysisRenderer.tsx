// Shared renderer for emoji-structured AI analysis text.
// Used by WorkerAnalyticsTab (card AI panel) and PerformancePanelSection.

const C_LIME = '#16a34a'

export const SECTION_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  '📊': { bg: '#F0F4FF', color: '#1D4ED8', border: '#BFDBFE' },
  '💪': { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
  '📉': { bg: '#FFFBEB', color: '#D97706', border: '#FDE68A' },
  '⚠️': { bg: '#FFF7ED', color: '#C2410C', border: '#FDBA74' },
  '🔍': { bg: '#F5F3FF', color: '#6D28D9', border: '#DDD6FE' },
  '🧠': { bg: '#FDF4FF', color: '#9333EA', border: '#E9D5FF' },
  '🔄': { bg: '#F0F9FF', color: '#0369A1', border: '#BAE6FD' },
  '📝': { bg: '#F8FAFC', color: '#475569', border: '#CBD5E1' },
  '✅': { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
}

export function inlineBold(text: string, baseColor = '#374151') {
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  if (parts.length === 1) return <span style={{ color: baseColor }}>{text}</span>
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**')
          ? <strong key={i} style={{ color: baseColor, fontWeight: 700 }}>{p.slice(2, -2)}</strong>
          : <span key={i} style={{ color: baseColor }}>{p}</span>
      )}
    </>
  )
}

export function AnalysisRenderer({ text, streaming }: { text: string; streaming: boolean }) {
  const sections: { heading: string; emoji: string; lines: string[] }[] = []
  let current: { heading: string; emoji: string; lines: string[] } | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const emojiMatch = line.match(/^([📊💪📉⚠️🔍🧠🔄📝✅])\s+(.+)/)
    if (emojiMatch) {
      if (current) sections.push(current)
      current = { emoji: emojiMatch[1], heading: line, lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(current)

  if (!sections.length) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: '#374151' }}>
          {text}
          {streaming && <span className="inline-block w-1.5 h-3 ml-0.5 align-middle animate-pulse rounded-sm" style={{ background: C_LIME }} />}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0">
      {sections.map((sec, i) => {
        const style = SECTION_STYLE[sec.emoji] ?? { bg: '#F9FAFB', color: '#374151', border: '#E5E7EB' }
        const bodyLines = sec.lines.filter(l => l.trim())
        const isLast = i === sections.length - 1

        return (
          <div key={i} className="px-4 py-3 border-b last:border-b-0" style={{ borderColor: '#D9E6E8' }}>
            <div
              className="flex items-center gap-2 mb-2 pl-2"
              style={{ borderLeft: `3px solid ${style.color}` }}
            >
              <span className="text-sm font-bold" style={{ color: style.color }}>
                {sec.heading}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              {bodyLines.map((line, j) => {
                const isArrow = line.startsWith('→')
                const isNum   = /^\d+\./.test(line.trim())
                const isDash  = line.trim().startsWith('- ')

                if (isArrow) {
                  return (
                    <div key={j} className="flex items-start gap-2 rounded-lg px-2 py-1.5" style={{ background: style.bg }}>
                      <span className="text-xs font-bold shrink-0 mt-px" style={{ color: style.color }}>→</span>
                      <span className="text-xs leading-snug">{inlineBold(line.slice(1).trim())}</span>
                    </div>
                  )
                }
                if (isNum) {
                  const num  = line.match(/^(\d+)\.\s*/)?.[1] ?? ''
                  const body = line.replace(/^\d+\.\s*/, '')
                  return (
                    <div key={j} className="flex items-start gap-2">
                      <span
                        className="text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                        style={{ background: style.color, color: '#fff' }}
                      >{num}</span>
                      <span className="text-xs leading-snug">{inlineBold(body)}</span>
                    </div>
                  )
                }
                if (isDash) {
                  return (
                    <div key={j} className="flex items-start gap-1.5">
                      <span className="text-xs shrink-0 mt-0.5" style={{ color: style.color }}>•</span>
                      <span className="text-xs leading-snug">{inlineBold(line.replace(/^-\s*/, ''))}</span>
                    </div>
                  )
                }
                return (
                  <p key={j} className="text-xs leading-relaxed">{inlineBold(line)}</p>
                )
              })}
              {streaming && isLast && (
                <span className="inline-block w-1.5 h-3 mt-1 animate-pulse rounded-sm" style={{ background: C_LIME }} />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
