import { useEffect, useState } from 'react';
import { X, MapPin, Briefcase, Users, Calendar, Tag, ExternalLink, ZoomIn, ImageOff, Sparkles, AlertTriangle, Languages, Loader2 } from 'lucide-react';
import type { DailyReport } from '../../types/report';
import { getDriveThumbnailUrl, extractDriveFileId } from '../../utils/driveImage';
import { apiFetch } from '../../utils/apiFetch';

interface Props {
  report: DailyReport;
  onClose: () => void;
}

interface TocAnalysis {
  toc_category:           'Activity' | 'Output' | 'Outcome' | 'Impact';
  toc_justification:      string;
  translated_description: string;
  vernacular_idioms:      { original: string; meaning: string }[];
  systemic_barriers:      string[];
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const TOC_STYLES: Record<string, { badge: string; dot: string; label: string }> = {
  Activity: { badge: 'bg-blue-50 text-blue-700 border-blue-200',   dot: 'bg-blue-500',   label: 'Activity' },
  Output:   { badge: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500',  label: 'Output'   },
  Outcome:  { badge: 'bg-purple-50 text-purple-700 border-purple-200', dot: 'bg-purple-500', label: 'Outcome' },
  Impact:   { badge: 'bg-rose-50 text-rose-700 border-rose-200',    dot: 'bg-rose-500',   label: 'Impact'   },
};

export function ReportDetailModal({ report: r, onClose }: Props) {
  const [lightbox, setLightbox] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [analysis, setAnalysis] = useState<TocAnalysis | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const thumbUrl   = r.attachmentUrl ? getDriveThumbnailUrl(r.attachmentUrl, 'w1200') : null;
  const driveFileId = r.attachmentUrl ? extractDriveFileId(r.attachmentUrl) : null;
  const fullUrl    = driveFileId
    ? `https://lh3.googleusercontent.com/d/${driveFileId}`
    : thumbUrl;

  // Fire-and-forget; never blocks the modal opening
  useEffect(() => {
    if (!r.description?.trim()) return;
    setLoadingAnalysis(true);
    setAnalysisError(null);

    const ctrl = new AbortController();

    apiFetch('/api/analyze-report-impact', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        description: r.description,
        location:    r.location,
        state:       r.state,
      }),
      signal: ctrl.signal,
    })
      .then(res => res.ok ? res.json() : res.json().then(e => Promise.reject(e.error || 'AI analysis failed')))
      .then((data: TocAnalysis) => setAnalysis(data))
      .catch(err => { if (err?.name !== 'AbortError') setAnalysisError(String(err)) })
      .finally(() => setLoadingAnalysis(false));

    return () => ctrl.abort();
  }, [r.description, r.location, r.state]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (lightbox) setLightbox(false);
        else onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, lightbox]);

  const fields = [
    { label: 'Submitted',     icon: Calendar,  value: formatDate(r.timestamp) },
    { label: 'Name',          icon: null,      value: r.name },
    { label: 'State',         icon: MapPin,    value: r.state },
    { label: 'Location',      icon: MapPin,    value: r.location },
    { label: 'Project',       icon: Briefcase, value: r.project },
    { label: 'Area',          icon: Tag,       value: r.areaOfIntervention },
    { label: 'Outreach Number', icon: Users,   value: r.beneficiaries !== null ? String(r.beneficiaries) : '—' },
  ];

  const tocStyle = analysis ? (TOC_STYLES[analysis.toc_category] ?? TOC_STYLES.Activity) : null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex justify-center pt-3 pb-1 sm:hidden">
            <div className="w-10 h-1 bg-gray-300 rounded-full" />
          </div>

          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 sticky top-0 bg-white z-10">
            <h2 className="font-semibold text-gray-900">Report Details</h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition" aria-label="Close">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          {thumbUrl && !imgError && (
            <div
              className="relative bg-gray-100 cursor-zoom-in"
              style={{ aspectRatio: '16/9' }}
              onClick={() => setLightbox(true)}
            >
              <img
                src={thumbUrl}
                alt="Field work photo"
                onError={() => setImgError(true)}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors" />
              <div className="absolute bottom-2 right-2 flex gap-1.5">
                <button
                  onClick={e => { e.stopPropagation(); setLightbox(true); }}
                  className="flex items-center gap-1 text-xs text-white bg-black/50 hover:bg-black/70 px-2 py-1 rounded-full transition backdrop-blur-sm"
                >
                  <ZoomIn className="w-3 h-3" />
                  Expand
                </button>
                <a
                  href={r.attachmentUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="flex items-center gap-1 text-xs text-white bg-black/50 hover:bg-black/70 px-2 py-1 rounded-full transition backdrop-blur-sm"
                >
                  <ExternalLink className="w-3 h-3" />
                  Drive
                </a>
              </div>
            </div>
          )}

          {thumbUrl && imgError && (
            <div className="mx-4 mt-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <ImageOff className="w-4 h-4 shrink-0" />
              <span>Photo couldn't load — file may need public access in Drive.</span>
            </div>
          )}

          {!thumbUrl && (
            <div className="mx-4 mt-4 flex items-center gap-2 text-sm text-gray-400 bg-gray-50 border border-gray-100 rounded-xl px-4 py-3">
              <ImageOff className="w-4 h-4 shrink-0" />
              <span>No photo attached to this report.</span>
            </div>
          )}

          <dl className="px-4 py-4 space-y-4">
            {fields.map(({ label, icon: Icon, value }) => (
              <div key={label} className="flex gap-3">
                {Icon
                  ? <Icon className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                  : <div className="w-4 shrink-0" />
                }
                <div className="min-w-0">
                  <dt className="text-xs text-gray-400 font-medium uppercase tracking-wide">{label}</dt>
                  <dd className="text-sm text-gray-800 mt-0.5 break-words">{value}</dd>
                </div>
              </div>
            ))}

            <div className="flex gap-3">
              <div className="w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <dt className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1">Description</dt>
                <dd className="text-sm text-gray-800 whitespace-pre-line leading-relaxed">{r.description}</dd>
              </div>
            </div>

            {r.attachmentUrl && (
              <a
                href={r.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 rounded-xl px-4 py-3 hover:bg-blue-100 transition"
              >
                <ExternalLink className="w-4 h-4 shrink-0" />
                Open in Google Drive
              </a>
            )}
          </dl>

          {/* AI qualitative analysis */}
          <div className="mx-4 mb-5">
            <div className="border border-gray-100 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
                <Sparkles className="w-4 h-4 text-violet-500 shrink-0" />
                <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                  AI Qualitative Analysis &amp; Metaphor Decoder
                </span>
                {loadingAnalysis && (
                  <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin ml-auto" />
                )}
              </div>

              {loadingAnalysis && (
                <div className="px-4 py-4 space-y-3 animate-pulse">
                  <div className="h-4 bg-gray-100 rounded-full w-24" />
                  <div className="h-3 bg-gray-100 rounded-full w-full" />
                  <div className="h-3 bg-gray-100 rounded-full w-5/6" />
                  <div className="h-3 bg-gray-100 rounded-full w-4/6" />
                </div>
              )}

              {!loadingAnalysis && analysisError && (
                <div className="px-4 py-4 text-sm text-amber-700">
                  Could not load AI analysis — {analysisError}
                </div>
              )}

              {!loadingAnalysis && analysis && tocStyle && (
                <div className="px-4 py-4 space-y-4">

                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1.5">
                        Theory of Change Tier
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${tocStyle.badge}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${tocStyle.dot}`} />
                          {tocStyle.label}
                        </span>
                      </div>
                      {analysis.toc_justification && (
                        <p className="mt-2 text-xs text-gray-600 leading-relaxed">
                          {analysis.toc_justification}
                        </p>
                      )}
                    </div>
                  </div>

                  {analysis.translated_description &&
                    analysis.translated_description.trim() !== r.description?.trim() && (
                    <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Languages className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          Professional Translation
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 leading-relaxed">
                        {analysis.translated_description}
                      </p>
                    </div>
                  )}

                  {analysis.vernacular_idioms.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">
                        Vernacular Phrases Decoded
                      </p>
                      <div className="rounded-xl border border-gray-100 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 border-b border-gray-100">
                              <th className="text-left px-3 py-2 text-gray-500 font-medium w-1/2">Original Phrase</th>
                              <th className="text-left px-3 py-2 text-gray-500 font-medium w-1/2">Meaning</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {analysis.vernacular_idioms.map((idiom, i) => (
                              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                                <td className="px-3 py-2 text-gray-700 italic align-top">{idiom.original}</td>
                                <td className="px-3 py-2 text-gray-600 align-top">{idiom.meaning}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {analysis.systemic_barriers.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 mb-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                          Systemic Barriers Identified
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {analysis.systemic_barriers.map((barrier, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200"
                          >
                            {barrier}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {lightbox && fullUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightbox(false)}
        >
          <button
            onClick={() => setLightbox(false)}
            className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition"
            aria-label="Close lightbox"
          >
            <X className="w-6 h-6 text-white" />
          </button>

          <img
            src={fullUrl}
            alt="Field work photo — full size"
            onClick={e => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onError={() => {
              setLightbox(false);
            }}
          />

          <a
            href={r.attachmentUrl!}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="absolute bottom-4 right-4 flex items-center gap-1.5 text-xs text-white bg-white/10 hover:bg-white/20 px-3 py-2 rounded-full transition backdrop-blur-sm"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Drive
          </a>
        </div>
      )}
    </>
  );
}
