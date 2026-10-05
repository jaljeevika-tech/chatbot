// Story Finder tab: top 5 stories as cards, plus a custom-story input.

import { useEffect, useRef, useState } from 'react'
import { X, Quote, MapPin, Tag, Calendar, ImageOff, Save, Check, Sparkles, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { EmptyState } from '../ui/EmptyState'
import { BadgePill } from '../ui/BadgePill'
import { formatDate } from '../../utils/format'
import {
  fetchTopStories, fetchCustomStory, saveStoryAsReport,
  type Story,
} from '../../utils/storyFinderClient'
import type { DailyReport, ActiveFilters } from '../../types/report'

interface Props {
  reports:  DailyReport[]
  userName: string
  filters:  ActiveFilters
  onClose:  () => void
}

type Status = 'loading' | 'ready' | 'error' | 'empty'
type CustomStatus = 'idle' | 'generating' | 'error'

export function StoryFinderView({ reports, userName, filters, onClose }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [stories, setStories] = useState<Story[]>([])
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [note, setNote] = useState<string>('')
  const [groundingScore, setGroundingScore] = useState<number>(0)
  const [droppedCount, setDroppedCount] = useState<number>(0)

  const [customReq, setCustomReq] = useState('')
  const [customCount, setCustomCount] = useState(1)
  const [customStories, setCustomStories] = useState<Story[]>([])
  const [customStatus, setCustomStatus] = useState<CustomStatus>('idle')
  const [customError, setCustomError] = useState<string>('')
  const [customNote, setCustomNote] = useState<string>('')

  const abortRef = useRef<AbortController | null>(null)
  const customAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('loading')

    fetchTopStories({ reports, userName, filters, signal: controller.signal })
      .then(resp => {
        if (controller.signal.aborted) return
        setStories(resp.stories)
        setGroundingScore(resp.grounding_score ?? 0)
        setDroppedCount(resp.dropped ?? 0)
        setNote(resp.note ?? '')
        setStatus(resp.stories.length === 0 ? 'empty' : 'ready')
      })
      .catch(e => {
        if (controller.signal.aborted) return
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })

    return () => controller.abort()
  // Only on tab open; filters can be changed beforehand.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function generateCustom() {
    const text = customReq.trim()
    if (!text || customStatus === 'generating') return
    customAbortRef.current?.abort()
    const controller = new AbortController()
    customAbortRef.current = controller
    setCustomStatus('generating')
    setCustomError('')
    setCustomNote('')
    try {
      const resp = await fetchCustomStory({
        reports, userName, filters,
        customRequirement: text,
        count: customCount,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (!resp.stories.length) {
        setCustomError(resp.note || 'No story could be generated — try a different requirement.')
        setCustomStatus('error')
      } else {
        setCustomStories(resp.stories)
        if (resp.stories.length < customCount) {
          setCustomNote(`${resp.stories.length} of ${customCount} requested stories passed grounding validation.`)
        }
        setCustomStatus('idle')
      }
    } catch (e) {
      if (controller.signal.aborted) return
      setCustomError(e instanceof Error ? e.message : String(e))
      setCustomStatus('error')
    }
  }

  function discardCustomStory(id: string) {
    setCustomStories(prev => prev.filter(s => s.id !== id))
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4">
      <header className="flex items-center justify-between mb-5 pt-2">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-purple-700" />
            </div>
            <h1 className="text-lg font-bold text-gray-900">Story Finder</h1>
          </div>
          <p className="text-xs text-gray-500 mt-1 ml-10">
            {status === 'loading'
              ? `Mining ${reports.length} reports for human-impact stories…`
              : `Top stories surfaced from ${reports.length} field reports${groundingScore ? ` · grounding ${Math.round(groundingScore * 100)}%` : ''}`}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close Story Finder"
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {status === 'loading' && (
        <div className="py-20 flex flex-col items-center gap-3 text-sm text-gray-500">
          <LoadingSpinner size="lg" tone="brand" />
          <span>Generating top 5 stories — this takes ~10 seconds.</span>
        </div>
      )}

      {status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-2 my-6">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-red-700">Couldn't load stories</p>
            <p className="text-red-600 mt-0.5">{errorMsg}</p>
          </div>
        </div>
      )}

      {status === 'empty' && (
        <EmptyState
          icon={<Sparkles className="w-8 h-8" />}
          title="No story-worthy reports yet"
          body={note || "We need a few more descriptive field reports before stories can be surfaced. Try widening your filters or adding more detail to recent reports."}
        />
      )}

      {status === 'ready' && (
        <>
          {droppedCount > 0 && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 mb-3 inline-block">
              {droppedCount} candidate{droppedCount === 1 ? '' : 's'} filtered out for grounding · only verified stories shown
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {stories.map(s => (
              <StoryCard key={s.id} story={s} reportCount={reports.length} variant="top" />
            ))}
          </div>
        </>
      )}

      {/* Custom story panel */}
      <section className="mt-8 border-t border-gray-200 pt-6">
        <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-600" />
          Need a story for a specific audience or theme?
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          Describe what you need — focus area, audience, beneficiary type, length, tone. We'll generate tailored stories from the same data.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            value={customReq}
            onChange={e => setCustomReq(e.target.value)}
            placeholder="e.g. A story about women's leadership in fisheries for a CSR donor newsletter."
            rows={3}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            disabled={customStatus === 'generating'}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="custom-story-count" className="text-xs text-gray-600 font-medium">
              Number of stories
            </label>
            <select
              id="custom-story-count"
              value={customCount}
              onChange={e => setCustomCount(Number(e.target.value))}
              disabled={customStatus === 'generating'}
              className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 bg-white"
            >
              {[1, 2, 3, 5, 8, 10].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <button
              onClick={generateCustom}
              disabled={!customReq.trim() || customStatus === 'generating' || status === 'loading'}
              className="ml-auto px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
            >
              {customStatus === 'generating'
                ? <><LoadingSpinner size="xs" tone="white" /> Generating…</>
                : <>Generate {customCount > 1 ? `${customCount} stories` : 'custom story'}</>}
            </button>
          </div>
        </div>
        {customError && (
          <p className="text-xs text-red-600 mt-2 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" /> {customError}
          </p>
        )}
        {customNote && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 mt-2 inline-block">
            {customNote}
          </p>
        )}
        {customStories.length > 0 && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {customStories.map(s => (
              <StoryCard
                key={s.id}
                story={s}
                reportCount={reports.length}
                variant="custom"
                onDiscard={() => discardCustomStory(s.id)}
              />
            ))}
          </div>
        )}
      </section>

      <div className="h-8" />
    </div>
  )
}

function StoryCard({
  story, reportCount, variant, onDiscard,
}: {
  story: Story
  reportCount: number
  variant: 'top' | 'custom'
  onDiscard?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [saveError, setSaveError] = useState('')

  async function handleSave() {
    if (saving || saved) return
    setSaving(true)
    setSaveError('')
    try {
      await saveStoryAsReport(story, reportCount)
      setSaved(true)
      setTimeout(() => setSaved(false), 4000)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const paragraphs = story.narrative.split(/\n\s*\n/).filter(p => p.trim().length > 0)
  const truncated = !expanded && paragraphs.length > 2
  const visible = truncated ? paragraphs.slice(0, 2) : paragraphs

  return (
    <article className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm flex flex-col">
      {story.primary_photo_url && !imgError && (
        <div className="w-full bg-gray-100" style={{ aspectRatio: '16/9' }}>
          <img
            src={story.primary_photo_url}
            alt="Field photo"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      {story.primary_photo_url && imgError && (
        <div className="w-full h-10 bg-gray-50 flex items-center justify-center gap-1.5 text-xs text-gray-400 border-b border-gray-100">
          <ImageOff className="w-3.5 h-3.5" /> Photo unavailable
        </div>
      )}

      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {variant === 'top'
              ? <BadgePill tone="purple" size="xs">Top story</BadgePill>
              : <BadgePill tone="amber" size="xs">Custom</BadgePill>}
            {story.quality_flag === 'low_confidence' && (
              <BadgePill tone="amber" size="xs" title="Some claims couldn't be fully verified against source data.">
                Low confidence
              </BadgePill>
            )}
          </div>
          {variant === 'custom' && onDiscard && (
            <button
              onClick={onDiscard}
              className="text-[11px] text-gray-500 hover:text-gray-700 underline"
            >
              Discard
            </button>
          )}
        </div>

        {story.hook_quote && (
          <blockquote className="text-xs italic text-purple-700 border-l-2 border-purple-200 pl-3">
            <Quote className="inline w-3 h-3 mr-1 -mt-0.5" />
            {story.hook_quote}
          </blockquote>
        )}

        <h3 className="text-sm font-bold text-gray-900 leading-snug">{story.title}</h3>

        <div className="text-sm text-gray-700 leading-relaxed space-y-2">
          {visible.map((p, i) => (
            <p key={i} className="whitespace-pre-line">{p}</p>
          ))}
          {truncated && (
            <button
              onClick={() => setExpanded(true)}
              className="text-xs text-purple-700 hover:underline inline-flex items-center gap-1"
            >
              Read full story <ChevronDown className="w-3 h-3" />
            </button>
          )}
          {!truncated && paragraphs.length > 2 && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-xs text-purple-700 hover:underline inline-flex items-center gap-1"
            >
              Show less <ChevronUp className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="mt-auto pt-3 border-t border-gray-100 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
          {story.location && (
            <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{story.location}</span>
          )}
          {story.project && (
            <span className="inline-flex items-center gap-1"><Tag className="w-3 h-3" />{story.project}</span>
          )}
          {story.period?.from && (
            <span className="inline-flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {formatDate(story.period.from, { year: false })}
              {story.period.to && story.period.to !== story.period.from
                ? ` → ${formatDate(story.period.to, { year: false })}`
                : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving || saved}
            className="text-xs font-medium px-3 py-1.5 rounded-md border border-purple-300 text-purple-700 hover:bg-purple-50 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {saved
              ? <><Check className="w-3 h-3" /> Saved</>
              : saving
                ? <><LoadingSpinner size="xs" tone="brand" /> Saving…</>
                : <><Save className="w-3 h-3" /> Save story</>}
          </button>
          {story.source_report_ids.length > 0 && (
            <button
              onClick={() => setShowSources(o => !o)}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1.5"
            >
              View source reports ({story.source_report_ids.length})
              {showSources ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
        {showSources && (
          <ul className="text-[11px] text-gray-600 bg-gray-50 rounded-md p-2 list-disc list-inside space-y-0.5">
            {story.source_report_ids.map(id => (
              <li key={id}><code className="text-[10px]">{id}</code></li>
            ))}
          </ul>
        )}
        {saveError && (
          <p className="text-[11px] text-red-600">{saveError}</p>
        )}
      </div>
    </article>
  )
}
