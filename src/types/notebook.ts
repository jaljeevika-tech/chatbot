export interface NotebookSource {
  id: string
  name: string
  type: 'pdf' | 'txt' | 'url' | 'docx' | 'pptx' | 'xlsx' | 'odt' | 'ods' | 'odp' | 'csv' | 'md' | 'rtf'
  content: string
  charCount: number
  addedAt: string
  /** Google Drive share links for field photos attached to report rows */
  imageUrls?: string[]
  /** Each photo's report-row description, used to match photos to relevant slides
   *  (see SlideDeck.tsx's pickRelevantPhoto). */
  imageCaptions?: Record<string, string>
  /** Where/when each photo was taken; Video Overview's provenance label. */
  imageMeta?: Record<string, { date?: string; place?: string }>
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string
}

export type StudyGuideFormat = 'summary' | 'faq' | 'timeline' | 'briefing'

export interface Slide {
  title: string
  bullets: string[]
  speakerNotes: string
  /** A source photo caption the model judged relevant to this slide; preferred
   *  over a client-side keyword guess (SlideDeck.tsx's useMixedPhotos). */
  matchedCaption?: string
}

export type AudioLine = { host: 'ALEX' | 'JORDAN'; text: string; tone?: string }

export interface NotebookMeta {
  id: string
  name: string
  created_at: string
  updated_at: string
  source_count: number
  message_count: number
}

export interface MindMapNode {
  label: string
  children: MindMapNode[]
}

/** Visual slide segment synced to a dialogue line range (POST /api/notebook/video-slides). */
export interface VideoSlide {
  fromLine: number
  toLine: number
  title: string
  visual: 'list' | 'stat' | 'quote'
  bullets?: string[]
  stat?: { value: string; label: string }
  quote?: string
  quoteAttribution?: string
  // Documentary fields: optional, the model omits them rather than guess.
  /** Set on the first segment of each act — shown as a chapter card. */
  chapter?: string
  /** Real place being discussed, as the sources name it — the location super. */
  location?: string
  /** Real date/period being discussed. */
  date?: string
  /** Which source these facts come from — credited on the card. */
  source?: string
  /** Index into the photos sent with the request. */
  photo?: number
  /** Persisted form of `photo`, converted on arrival so later source changes can't repoint it. */
  photoUrl?: string
  /** What the picture should show (drives the AI image prompt). Older saves only;
   *  newer segments carry one scene per shot. */
  scene?: string
  /** First segment only: the film's one-sentence core message. */
  headline?: string
  /** Pictures under this card, a new one per concrete subject (see videoShots.ts).
   *  Absent on older saves. */
  shots?: VideoShot[]
}

/** One picture, cut in at sentence `sentence` (0-based) of narration line `line`,
 *  held until the next shot. */
export interface VideoShot {
  line: number
  sentence: number
  /** Concrete English description of what this picture shows. */
  scene?: string
  /** Model's positional pick from the photo catalogue (converted to photoUrl on arrival). */
  photo?: number
  /** Real field photo shown for this shot instead of an AI picture. */
  photoUrl?: string
}

// Persisted output shapes: one JSONB blob per kind via /api/notebooks/:id/outputs/:kind
// (db/migrations/074_notebook_outputs.sql).

export interface StudyGuideOutputData {
  format: StudyGuideFormat
  content: string
}

export interface SlideDeckOutputData {
  slides: Slide[]
  slideImages: (string | null)[]
  mode: 'detailed' | 'presenter'
}

export interface MindMapOutputData {
  tree: MindMapNode
}

export interface VideoOverviewOutputData {
  lines: AudioLine[]
  videoSlides: VideoSlide[]
  languageCode: string
  alexVoice: string
  jordanVoice: string
  /** Background photo style (VideoOverview.tsx's DESIGN_STYLES); absent means 'photorealistic'. */
  designStyle?: string
  /** Narration tone (voices.ts VIDEO_TONES); absent means 'energetic'. */
  videoTone?: string
  /** Frame the script and pictures were made for; absent means landscape. */
  aspect?: 'landscape' | 'portrait'
  /** 'story' = full-screen pictures with captions (default); 'briefing' = key points
   *  beside the picture. */
  layout?: 'story' | 'briefing'
}

/** Podcast script + voice settings. The audio itself is cached per-device in
 *  IndexedDB (src/utils/notebookMediaCache.ts). */
export interface AudioOverviewOutputData {
  lines: AudioLine[]
  languageCode: string
  alexVoice: string
  jordanVoice: string
  customPrompt?: string
}

export interface Flashcard {
  front: string
  back: string
}

export interface QuizQuestion {
  question: string
  options: string[]
  correctIndex: number
  explanation?: string
}

export interface FlashcardsQuizOutputData {
  flashcards: Flashcard[]
  quiz: QuizQuestion[]
}

export interface NotebookOutputs {
  study_guide?:     { data: StudyGuideOutputData;     updatedAt: string }
  slide_deck?:      { data: SlideDeckOutputData;      updatedAt: string }
  mind_map?:        { data: MindMapOutputData;        updatedAt: string }
  video_overview?:  { data: VideoOverviewOutputData;  updatedAt: string }
  flashcards_quiz?: { data: FlashcardsQuizOutputData; updatedAt: string }
  audio_overview?:  { data: AudioOverviewOutputData;  updatedAt: string }
}
