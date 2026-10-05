// "Learn" output tab: flashcards + multiple-choice quiz from the notebook's sources
// (/api/notebook/flashcards-quiz).

import { useState, useEffect } from 'react'
import { apiFetch } from '../../utils/apiFetch'
import { GraduationCap, Loader2, AlertCircle, Sparkles, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, RotateCcw, Check, X } from 'lucide-react'
import { SubscriptionGate } from '../subscription/SubscriptionGate'
import type { NotebookSource, FlashcardsQuizOutputData } from '../../types/notebook'

const C = { dark: '#0E3A46', lime: '#341272', bg: '#F2F7F8', white: '#FFFFFF', sidebar: '#341272' }

// Repair common AI JSON mistakes: strip code fences, escape bare newlines inside strings
function cleanJSON(raw: string): string {
  const s = raw.replace(/^```(?:json)?\s*/im, '').replace(/```\s*$/m, '').trim()
  let out = '', inStr = false, escaped = false
  for (const ch of s) {
    if (escaped)              { out += ch; escaped = false; continue }
    if (ch === '\\')          { out += ch; escaped = true;  continue }
    if (ch === '"')           { inStr = !inStr; out += ch;  continue }
    if (inStr && ch === '\n') { out += '\\n'; continue }
    if (inStr && ch === '\r') { out += '\\r'; continue }
    if (inStr && ch === '\t') { out += '\\t'; continue }
    out += ch
  }
  return out
}

async function streamSSE(url: string, body: object): Promise<string> {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.body) throw new Error('No stream')
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    try { const j = JSON.parse(errBody); throw new Error(j.error || `HTTP ${res.status}`) }
    catch (e2) { if (e2 instanceof SyntaxError) throw new Error(`HTTP ${res.status}`); throw e2 }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let accum = '', buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const raw = trimmed.slice(6).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const chunk = JSON.parse(raw)
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.text) accum += chunk.text
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }
  return accum
}

type LearnMode = 'flashcards' | 'quiz'

interface Props {
  sources: NotebookSource[]
  /** Saved deck/quiz, restored on notebook load. */
  initial?: FlashcardsQuizOutputData
  onChange?: (data: FlashcardsQuizOutputData) => void
  /** Reported up so OutputPanel can show a spinner and keep this tab mounted. */
  onBusyChange?: (busy: boolean) => void
}

export function FlashcardsQuiz({ sources, initial, onChange, onBusyChange }: Props) {
  const [data, setData]       = useState<FlashcardsQuizOutputData | null>(initial ?? null)
  const [mode, setMode]       = useState<LearnMode>('flashcards')
  const [loading, setLoading] = useState(false)
  useEffect(() => { onBusyChange?.(loading) }, [loading, onBusyChange])
  const [error, setError]     = useState<string | null>(null)
  const [showPrompt, setShowPrompt]     = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')

  const [cardIndex, setCardIndex] = useState(0)
  const [flipped, setFlipped]     = useState(false)

  const [qIndex, setQIndex]     = useState(0)
  const [answers, setAnswers]   = useState<(number | null)[]>([])

  async function generate() {
    if (sources.length === 0) return
    setLoading(true); setError(null)
    setCardIndex(0); setFlipped(false); setQIndex(0); setAnswers([])
    try {
      const accum = await streamSSE('/api/notebook/flashcards-quiz', {
        sources: sources.map(s => ({ name: s.name, content: s.content.slice(0, 40_000) })),
        customPrompt,
      })
      const jsonMatch = accum.match(/\{[\s\S]*\}/)
      if (!jsonMatch) { setError('Could not parse flashcards/quiz. Try generating again.'); return }
      const parsed = JSON.parse(cleanJSON(jsonMatch[0])) as FlashcardsQuizOutputData
      setData(parsed)
      setAnswers(new Array(parsed.quiz?.length || 0).fill(null))
      onChange?.(parsed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  const noSources   = sources.length === 0
  const flashcards  = data?.flashcards ?? []
  const quiz        = data?.quiz ?? []
  const card        = flashcards[cardIndex]
  const question     = quiz[qIndex]
  const quizFinished = quiz.length > 0 && qIndex >= quiz.length
  const score        = answers.filter((a, i) => a !== null && a === quiz[i]?.correctIndex).length
  const answeredCount = answers.filter(a => a !== null).length

  function goToCard(i: number) {
    setCardIndex(Math.max(0, Math.min(flashcards.length - 1, i)))
    setFlipped(false)
  }

  function selectAnswer(i: number) {
    if (answers[qIndex] !== null) return // already answered this question
    setAnswers(prev => { const next = [...prev]; next[qIndex] = i; return next })
  }

  function retakeQuiz() {
    setQIndex(0)
    setAnswers(new Array(quiz.length).fill(null))
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b shrink-0" style={{ borderColor: '#D9E6E8' }}>
        <div className="flex gap-1 p-0.5 rounded-lg mb-2.5" style={{ background: C.bg }}>
          {(['flashcards', 'quiz'] as LearnMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="flex-1 py-1.5 rounded-md text-[11px] font-bold transition-all capitalize"
              style={{ background: mode === m ? C.dark : 'transparent', color: mode === m ? C.white : '#86A0A5' }}
            >
              {m === 'flashcards' ? 'Flashcards' : 'Quiz'}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowPrompt(v => !v)}
          className="w-full flex items-center gap-1.5 mb-2 text-[11px] font-semibold transition-all"
          style={{ color: showPrompt ? C.dark : '#86A0A5' }}
        >
          <Sparkles className="w-3 h-3" />
          Custom instructions
          {showPrompt ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
        </button>
        {showPrompt && (
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            placeholder="Focus on a specific topic, adjust difficulty, or target a particular audience…"
            rows={3}
            className="w-full text-[11px] rounded-xl px-3 py-2 mb-2 resize-none outline-none"
            style={{ background: C.bg, color: '#374151', border: '1.5px solid #D9E6E8' }}
          />
        )}

        <SubscriptionGate featureName="AI Flashcards & Quiz">
          <button
            onClick={generate}
            disabled={loading || noSources}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-bold transition-all"
            style={{ background: noSources || loading ? '#D9E6E8' : C.dark, color: noSources || loading ? '#86A0A5' : C.white }}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GraduationCap className="w-3.5 h-3.5" />}
            {loading ? 'Building study material…' : data ? 'Regenerate' : 'Generate flashcards & quiz'}
          </button>
        </SubscriptionGate>
        {error && (
          <p className="mt-2 text-[11px] flex items-center gap-1" style={{ color: '#DC2626' }}>
            <AlertCircle className="w-3 h-3 shrink-0" />{error}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {!data ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <GraduationCap className="w-8 h-8" style={{ color: C.lime }} />
            <p className="text-xs font-semibold" style={{ color: C.dark }}>Flashcards &amp; Quiz</p>
            <p className="text-[11px]" style={{ color: '#86A0A5' }}>
              {noSources ? 'Add sources first' : 'Generate a study deck and quiz from your sources'}
            </p>
          </div>

        ) : mode === 'flashcards' ? (
          flashcards.length === 0 ? (
            <p className="text-xs text-center pt-8" style={{ color: '#86A0A5' }}>No flashcards generated.</p>
          ) : (
            <div className="flex flex-col gap-3 h-full">
              <button
                onClick={() => setFlipped(v => !v)}
                className="flex-1 rounded-2xl flex items-center justify-center p-6 text-center transition-all"
                style={{ background: flipped ? C.dark : C.white, border: `1.5px solid ${C.bg === C.white ? '#D9E6E8' : '#D9E6E8'}`, minHeight: 200 }}
              >
                <p className="text-sm font-semibold leading-relaxed" style={{ color: flipped ? C.white : C.dark }}>
                  {flipped ? card?.back : card?.front}
                </p>
              </button>
              <p className="text-center text-[10px]" style={{ color: '#86A0A5' }}>
                {flipped ? 'Showing answer — tap to flip back' : 'Tap the card to reveal the answer'}
              </p>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => goToCard(cardIndex - 1)}
                  disabled={cardIndex === 0}
                  className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: cardIndex === 0 ? '#D9E6E8' : C.bg, color: cardIndex === 0 ? '#86A0A5' : C.dark }}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="flex-1 text-center text-[11px] font-semibold" style={{ color: '#86A0A5' }}>
                  {cardIndex + 1} / {flashcards.length}
                </span>
                <button
                  onClick={() => goToCard(cardIndex + 1)}
                  disabled={cardIndex === flashcards.length - 1}
                  className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: cardIndex === flashcards.length - 1 ? '#D9E6E8' : C.bg, color: cardIndex === flashcards.length - 1 ? '#86A0A5' : C.dark }}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )

        ) : quiz.length === 0 ? (
          <p className="text-xs text-center pt-8" style={{ color: '#86A0A5' }}>No quiz questions generated.</p>

        ) : quizFinished ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <GraduationCap className="w-10 h-10" style={{ color: C.lime }} />
            <p className="text-lg font-black" style={{ color: C.dark }}>Score: {score} / {quiz.length}</p>
            <button
              onClick={retakeQuiz}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold"
              style={{ background: C.dark, color: C.white }}
            >
              <RotateCcw className="w-3.5 h-3.5" />Retake quiz
            </button>
          </div>

        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] font-semibold" style={{ color: '#86A0A5' }}>
              Question {qIndex + 1} / {quiz.length} · {answeredCount} answered
            </p>
            <p className="text-sm font-bold leading-snug" style={{ color: C.dark }}>{question.question}</p>

            <div className="flex flex-col gap-2">
              {question.options.map((opt, i) => {
                const selected  = answers[qIndex] === i
                const answered  = answers[qIndex] !== null
                const isCorrect = i === question.correctIndex
                let bg = C.white, border = '#D9E6E8', color = C.dark
                if (answered && isCorrect)            { bg = '#DCFCE7'; border = '#86EFAC'; color = '#166534' }
                else if (answered && selected)        { bg = '#FEE2E2'; border = '#FCA5A5'; color = '#991B1B' }
                return (
                  <button
                    key={i}
                    onClick={() => selectAnswer(i)}
                    disabled={answered}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold text-left transition-all"
                    style={{ background: bg, border: `1.5px solid ${border}`, color }}
                  >
                    {answered && isCorrect && <Check className="w-3.5 h-3.5 shrink-0" />}
                    {answered && selected && !isCorrect && <X className="w-3.5 h-3.5 shrink-0" />}
                    <span>{opt}</span>
                  </button>
                )
              })}
            </div>

            {answers[qIndex] !== null && question.explanation && (
              <p className="text-[11px] rounded-xl px-3 py-2" style={{ background: C.bg, color: '#5C7378' }}>
                {question.explanation}
              </p>
            )}

            {answers[qIndex] !== null && (
              <button
                onClick={() => setQIndex(i => i + 1)}
                className="self-end flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold"
                style={{ background: C.dark, color: C.white }}
              >
                {qIndex === quiz.length - 1 ? 'See score' : 'Next question'}
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
