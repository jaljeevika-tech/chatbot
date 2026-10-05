import Papa from 'papaparse';
import type { DailyReport } from '../types/report';
import { cleanReports } from './cleanReport';

function buildExportUrl(sheetId: string) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
}

// Resolves null (not []) on failure so a transient error can't be mistaken for an empty sheet.
export async function fetchReportsFromSheet(sheetId: string): Promise<DailyReport[] | null> {
  try {
    const response = await fetch(buildExportUrl(sheetId));
    if (!response.ok) {
      throw new Error(`Failed to fetch sheet: ${response.statusText}`);
    }
    const csvContent = await response.text();

    return new Promise((resolve, reject) => {
      Papa.parse(csvContent, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const mappedData = (results.data as any[]).map((row, index) => {
            const phone = (row['Phone'] || '').toString().replace(/[\s\-]/g, '').replace(/^\+/, '');

            const rawDate = row['Timestamp'] || '';
            let formattedDate = rawDate;

            if (rawDate.includes('/')) {
              const parts = rawDate.split(' ')[0].split('/');
              if (parts.length === 3) {
                // Export date order follows the sheet's locale. A part >12 must be the day, so
                // MM/DD sheets are detected; when both are <=12 assume DD/MM (India).
                let [first, second, y] = parts;
                const a = parseInt(first, 10);
                const b = parseInt(second, 10);
                let d = first, m = second;
                if (a > 12 && b <= 12) {
                } else if (b > 12 && a <= 12) {
                  // Unambiguous MM/DD: swap
                  d = second; m = first;
                }
                formattedDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
              }
            }

            return {
              id:                `sheet-${index}`,
              timestamp:         formattedDate,
              name:              row['Name'] || '',
              phone,
              state:             row['State'] || '',
              location:          row['Location'] || '',
              project:           row['Project'] || '',
              areaOfIntervention: row['Area of Intervention'] || '',
              description:       row['Description'] || '',
              beneficiaries:     row['Beneficiaries'] || 0,
              attachmentUrl:     row['Attachment (Drive URL)'] || null,
              source:            (row['Source'] || '').toLowerCase().includes('whatsapp') ? 'whatsapp' : 'sheet',
            };
          });
          resolve(cleanReports(mappedData as DailyReport[]));
        },
        error: (error: any) => reject(error),
      });
    });
  } catch (error) {
    console.error('Error fetching sheet data:', error);
    return null;
  }
}
