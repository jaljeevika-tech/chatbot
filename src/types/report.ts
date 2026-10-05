export interface DailyReport {
  id: string;
  timestamp: string;
  name: string;
  phone: string;
  state: string;
  location: string;
  project: string;
  areaOfIntervention: string;
  description: string;
  beneficiaries: number | string | null;
  attachmentUrl: string | null;
  source?: 'whatsapp' | 'web' | 'sheet';  // origin of submission
  // Data-correctness layer flags (server-populated; nullable for legacy rows)
  qualityFlag?: 'low_confidence' | 'needs_review' | 'photo_mismatch' | null;
  qualityConfidence?: number | null;
}

export interface ActiveFilters {
  project: string[];
  state: string[];
  area: string[];
  dateFrom: string;   // YYYY-MM-DD or ''
  dateTo: string;     // YYYY-MM-DD or ''
  workerName: string[]; // Filter for Admin/Manager
  location?: string[]; // Village/town-level filter — optional, only set by pickers that offer it (e.g. Case Study)
}
