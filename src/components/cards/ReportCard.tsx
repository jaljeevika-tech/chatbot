import { useState } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { MapPin, Users, ChevronDown, ChevronUp, Calendar, Tag, ImageOff } from 'lucide-react';
import type { DailyReport } from '../../types/report';
import { ReportDetailModal } from './ReportDetailModal';
import { QualityFlagBadge } from './QualityFlagBadge';
import { getDriveThumbnailUrl } from '../../utils/driveImage';
import { FF } from '../../theme/colors';

interface Props { report: DailyReport }

const PROJECT_STYLES: Record<string, { border: string; badge: string }> = {
  'Dasara':                { border: 'bg-orange-400', badge: 'bg-orange-100 text-orange-700 border-orange-200' },
  'Kosi Sahajeevan':       { border: 'bg-blue-400',   badge: 'bg-blue-100   text-blue-700   border-blue-200' },
  'UNDP ECRIC Project':    { border: 'bg-purple-400', badge: 'bg-purple-100 text-purple-700 border-purple-200' },
  'Bundelkhand Jaljeevika':{ border: 'bg-teal-400',   badge: 'bg-teal-100   text-teal-700   border-teal-200' },
  'Donor Project':         { border: 'bg-indigo-400', badge: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
};
const DEFAULT_STYLE = { border: 'bg-gray-300', badge: 'bg-gray-100 text-gray-700 border-gray-200' };

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const TRUNCATE_AT = 100;

export function ReportCard({ report: r }: Props) {
  const [expanded, setExpanded]   = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [imgError, setImgError]   = useState(false);
  const { t } = useLanguage();

  const style        = PROJECT_STYLES[r.project] ?? DEFAULT_STYLE;
  const isLong       = r.description.length > TRUNCATE_AT;
  const displayDesc  = expanded || !isLong ? r.description : r.description.slice(0, TRUNCATE_AT) + '…';
  const thumbUrl     = r.attachmentUrl ? getDriveThumbnailUrl(r.attachmentUrl, 'w600') : null;

  const beneficiaryNum = r.beneficiaries !== null
    ? (typeof r.beneficiaries === 'number' ? r.beneficiaries : parseInt(String(r.beneficiaries), 10))
    : null;
  const hasBeneficiaries = beneficiaryNum !== null && !isNaN(beneficiaryNum);

  return (
    <>
      <article className="bg-white rounded-xl border shadow-sm overflow-hidden hover:shadow-md transition-shadow" style={{ borderColor: FF.border }}>

        {thumbUrl && !imgError && (
          <div
            className="relative w-full bg-gray-100 cursor-pointer"
            style={{ aspectRatio: '16/9' }}
            onClick={() => setShowModal(true)}
          >
            <img
              src={thumbUrl}
              alt={t.fieldWorkPhoto}
              onError={() => setImgError(true)}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-black/0 hover:bg-black/10 transition-colors flex items-center justify-center">
              <span className="opacity-0 hover:opacity-100 transition-opacity text-white text-xs font-medium bg-black/50 px-2 py-1 rounded-full">
                {t.viewFullImage}
              </span>
            </div>
          </div>
        )}

        {thumbUrl && imgError && (
          <div className="w-full h-10 bg-gray-50 flex items-center justify-center gap-1.5 text-xs text-gray-400 border-b border-gray-100">
            <ImageOff className="w-3.5 h-3.5" />
            <span>{t.photoUnavailable}</span>
          </div>
        )}

        <div className="flex items-stretch">
          <div className={`w-1.5 shrink-0 ${style.border}`} />

          <div className="flex-1 p-3 sm:p-4 min-w-0">
            {r.name && (
              <div className="flex items-center gap-2 mb-3 pb-2.5 border-b border-gray-100">
                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-green-700">
                    {r.name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <span className="text-sm font-semibold text-gray-800 truncate">{r.name}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <Calendar className="w-3.5 h-3.5 shrink-0" />
                <span>{formatDate(r.timestamp)}</span>
                {r.source === 'whatsapp' && (
                  <span
                    className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: '#dcfce7', color: '#16a34a' }}
                    title="Submitted via WhatsApp"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
                    </svg>
                    WA
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {r.qualityFlag && (
                  <QualityFlagBadge
                    flag={r.qualityFlag}
                    confidence={r.qualityConfidence ?? undefined}
                  />
                )}
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${style.badge}`}>
                  {r.project}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-sm text-gray-700 mb-1.5">
              <MapPin className="w-4 h-4 text-gray-400 shrink-0" />
              <span className="font-medium truncate">{r.location}</span>
              <span className="text-gray-400 shrink-0">·</span>
              <span className="text-gray-500 shrink-0">{r.state}</span>
            </div>

            <div className="flex items-center gap-1.5 text-sm text-gray-600 mb-3">
              <Tag className="w-4 h-4 text-gray-400 shrink-0" />
              <span>{r.areaOfIntervention}</span>
            </div>

            {hasBeneficiaries && (
              <div className="flex items-center gap-1.5 text-sm text-gray-600 mb-3">
                <Users className="w-4 h-4 text-green-600 shrink-0" />
                <span><strong className="text-gray-900">{beneficiaryNum}</strong> {t.outreachNumber}</span>
              </div>
            )}

            <div className="pt-3 border-t border-gray-100">
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{displayDesc}</p>

              {isLong && (
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="mt-1.5 flex items-center gap-1 text-xs text-green-600 hover:text-green-700 transition"
                  aria-expanded={expanded}
                >
                  {expanded
                    ? <><ChevronUp   className="w-3.5 h-3.5" />{t.showLess}</>
                    : <><ChevronDown className="w-3.5 h-3.5" />{t.readMore}</>}
                </button>
              )}

              <button
                onClick={() => setShowModal(true)}
                className="mt-3 w-full text-sm text-green-600 font-medium border border-green-600 rounded-lg py-2 hover:bg-green-50 transition"
              >
                {t.fullDetails}
              </button>
            </div>
          </div>
        </div>
      </article>

      {showModal && <ReportDetailModal report={r} onClose={() => setShowModal(false)} />}
    </>
  );
}
