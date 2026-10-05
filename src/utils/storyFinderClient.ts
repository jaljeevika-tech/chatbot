// Typed fetch wrappers for POST /api/story-finder.

import { apiFetch } from './apiFetch'
import { slimReportsForApi } from './slimReport'
import type { DailyReport, ActiveFilters } from '../types/report'

export interface Story {
  id:               string
  title:            string
  narrative:        string
  hook_quote:       string
  source_report_ids: string[]
  primary_photo_url: string | null
  location:         string
  project:          string
  period:           { from: string; to: string }
  quality_flag?:    'low_confidence' | null
  grounding_score?: number
}

export interface StoryFinderResponse {
  stories:           Story[]
  grounding_score:   number
  dropped?:          number
  note?:             string
}

/** Top 5 story candidates from the current filtered reports. */
export async function fetchTopStories(args: {
  reports:  DailyReport[]
  userName: string
  filters:  ActiveFilters
  signal?:  AbortSignal
}): Promise<StoryFinderResponse> {
  const res = await apiFetch('/api/story-finder', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      reports:  slimReportsForApi(args.reports),
      userName: args.userName,
      filters:  args.filters,
      mode:     'top5',
    }),
    signal: args.signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Server error: ${res.status}`)
  }
  return await res.json()
}

/** Stories tailored to a user-supplied requirement. */
export async function fetchCustomStory(args: {
  reports:  DailyReport[]
  userName: string
  filters:  ActiveFilters
  customRequirement: string
  count?:   number
  signal?:  AbortSignal
}): Promise<StoryFinderResponse> {
  const res = await apiFetch('/api/story-finder', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      reports:  slimReportsForApi(args.reports),
      userName: args.userName,
      filters:  args.filters,
      mode:     'custom',
      customRequirement: args.customRequirement,
      count:    args.count ?? 1,
    }),
    signal: args.signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Server error: ${res.status}`)
  }
  return await res.json()
}

/** Save a story to Saved Reports. */
export async function saveStoryAsReport(story: Story, reportCount: number): Promise<void> {
  const content = [
    `# ${story.title}`,
    '',
    story.hook_quote ? `> ${story.hook_quote}` : '',
    '',
    story.narrative,
    '',
    '---',
    `*Location: ${story.location || '—'} · Project: ${story.project || '—'}` +
      ` · Period: ${story.period.from} → ${story.period.to}*`,
  ].filter(Boolean).join('\n')

  const res = await apiFetch('/api/saved-reports', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title:       story.title,
      content,
      reportCount,
      filters:     null,
      kind:        'self',
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Save failed: ${res.status}`)
  }
}
