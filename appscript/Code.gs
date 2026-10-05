// ============================================================
//  Daily Work Dashboard — Google Apps Script Backend
//  AI powered by Google Gemini API
// ============================================================

// ▶ STEP 1: Paste your Google Sheet ID here (from the URL)
//   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

// Sheet names to read (order = old first, new second)
const SHEET_NAMES = ['Daily Reports_old', 'Daily Reports'];

// Flexible column-name candidates (lowercase) for each field
const COL_MAP = {
  timestamp:     ['timestamp', 'date', 'submission date', 'submitted at', 'entry date'],
  name:          ['your name', 'name', 'field officer name', 'staff name', 'officer name', 'full name'],
  phone:         ['your phone number', 'phone', 'mobile', 'phone number', 'contact', 'mobile number'],
  state:         ['state'],
  location:      ['location/district', 'location', 'district', 'city', 'place'],
  project:       ['project name', 'project'],
  area:          ['area of intervention', 'area', 'intervention area', 'sector'],
  description:   ['description of work done', 'description', 'work done', 'details', 'remarks', 'activity'],
  beneficiaries: ['number of beneficiaries', 'beneficiaries', 'no. of beneficiaries', 'no of beneficiaries', 'total beneficiaries'],
  attachment:    ['attachment', 'photo', 'file', 'drive link', 'image', 'document'],
};

// ─────────────────────────────────────────────
//  Entry point — serves the web app
// ─────────────────────────────────────────────
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Daily Work Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─────────────────────────────────────────────
//  Read all records from both sheets
//  Returns: JSON string — array of DailyReport | { error }
// ─────────────────────────────────────────────
function getAllData() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const allData = [];
    let idCounter = 0;

    SHEET_NAMES.forEach(sheetName => {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet) return;

      const values = sheet.getDataRange().getValues();
      if (values.length < 2) return;

      // Build a lowercase header → column-index map
      const rawHeaders = values[0].map(h => String(h).trim().toLowerCase());

      // Resolve a logical field to its column index
      function colIdx(field) {
        const candidates = COL_MAP[field] || [field.toLowerCase()];
        for (const c of candidates) {
          const idx = rawHeaders.indexOf(c);
          if (idx !== -1) return idx;
        }
        return -1;
      }

      // Pre-resolve all column indices once per sheet
      const idx = {};
      Object.keys(COL_MAP).forEach(f => { idx[f] = colIdx(f); });

      const get = (row, field) => idx[field] !== -1 ? row[idx[field]] : null;

      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (row.every(c => c === '' || c == null)) continue; // skip blank rows

        // Format timestamp
        const rawTs = get(row, 'timestamp');
        let timestamp = '';
        if (rawTs instanceof Date) {
          timestamp = Utilities.formatDate(
            rawTs, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss"
          );
        } else if (rawTs) {
          timestamp = String(rawTs).trim();
        }

        // Normalise phone — digits only
        const rawPhone = get(row, 'phone');
        const phone = String(rawPhone == null ? '' : rawPhone).replace(/\D/g, '');

        allData.push({
          id:               'r' + (++idCounter),
          timestamp,
          name:             String(get(row, 'name')         || '').trim(),
          phone,
          state:            String(get(row, 'state')        || '').trim(),
          location:         String(get(row, 'location')     || '').trim(),
          project:          String(get(row, 'project')      || '').trim(),
          areaOfIntervention: String(get(row, 'area')       || '').trim(),
          description:      String(get(row, 'description')  || '').trim(),
          beneficiaries:    get(row, 'beneficiaries'),
          attachmentUrl:    String(get(row, 'attachment')   || '').trim() || null,
        });
      }
    });

    return JSON.stringify(allData);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

// ─────────────────────────────────────────────
//  Generate AI report via Gemini API
//  reportsJson : JSON string of DailyReport[]
//  userName    : string
//  Returns     : JSON string — { text } | { error }
// ─────────────────────────────────────────────
function generateAIReport(reportsJson, userName) {
  try {
    // ▶ STEP 2: Add your Gemini API key in
    //   Apps Script → Project Settings → Script Properties
    //   Key: GEMINI_API_KEY   Value: your key from aistudio.google.com
    const apiKey = PropertiesService.getScriptProperties()
      .getProperty('GEMINI_API_KEY');

    if (!apiKey) {
      return JSON.stringify({
        error: 'GEMINI_API_KEY not set.\n' +
               'Go to Apps Script → Project Settings → Script Properties\n' +
               'and add  GEMINI_API_KEY = <your key from aistudio.google.com>'
      });
    }

    const reports = JSON.parse(reportsJson);
    if (!Array.isArray(reports) || reports.length === 0) {
      return JSON.stringify({ error: 'No reports to analyse.' });
    }

    // Build a compact text summary (keeps payload small)
    const lines = reports.map((r, i) => {
      const date = typeof r.timestamp === 'string' ? r.timestamp.slice(0, 10) : 'N/A';
      return `${i + 1}. [${date}] Project: ${r.project || 'N/A'} | ` +
             `State: ${r.state || 'N/A'} | Location: ${r.location || 'N/A'} | ` +
             `Area: ${r.areaOfIntervention || 'N/A'} | ` +
             `Beneficiaries: ${r.beneficiaries ?? 'N/A'} | ` +
             `Work: ${(r.description || '').slice(0, 200)}`;
    });

    const prompt =
      `You are an expert field-work analyst for an NGO / development organisation.\n` +
      `Analyse the following ${reports.length} daily work report(s) submitted by "${userName}" ` +
      `and produce a comprehensive, well-structured report in Markdown.\n\n` +
      `Use these sections:\n` +
      `## Executive Summary\n## Work by Project\n## Geographic Coverage\n` +
      `## Impact & Beneficiaries\n## Timeline Analysis\n` +
      `## Key Achievements\n## Recommendations\n\n` +
      `--- REPORTS ---\n${lines.join('\n')}\n--- END ---`;

    // Gemini REST endpoint
    const model   = 'gemini-2.0-flash';
    const url     = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.7,
      },
      systemInstruction: {
        parts: [{
          text: 'You are an expert field-work analyst. Always respond in clear, structured Markdown.'
        }]
      }
    });

    const response = UrlFetchApp.fetch(url, {
      method:           'post',
      contentType:      'application/json',
      payload,
      muteHttpExceptions: true,
    });

    const raw    = response.getContentText();
    const result = JSON.parse(raw);

    // Handle API errors
    if (result.error) {
      return JSON.stringify({ error: result.error.message || JSON.stringify(result.error) });
    }

    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return JSON.stringify({ error: 'Gemini returned an empty response. Raw: ' + raw.slice(0, 300) });
    }

    return JSON.stringify({ text });

  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
