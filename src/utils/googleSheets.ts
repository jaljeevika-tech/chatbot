import Papa from 'papaparse';
import type { DailyReport } from '../types/report';
import { cleanReports, sheetRowToReport } from '../../lib/cleanReport';

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
          resolve(cleanReports((results.data as Record<string, unknown>[]).map(sheetRowToReport)));
        },
        error: (error: any) => reject(error),
      });
    });
  } catch (error) {
    console.error('Error fetching sheet data:', error);
    return null;
  }
}
