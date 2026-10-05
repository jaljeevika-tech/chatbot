import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, VerticalAlign,
} from 'docx';
import { saveAs } from 'file-saver';
import { getDriveThumbnailUrl } from './driveImage';
import { apiFetch } from './apiFetch';

// Brand theme (src/theme/colors.ts FF palette); docx wants bare hex, no '#'.
const THEME = {
  purple:     '341272',
  purpleDark: '1D0752',
  teal:       '0E3A46',
  headerBg:   '341272',   // table header row background
  headerFg:   'FFFFFF',   // table header row text
  stripeBg:   'F5F3FF',   // zebra-stripe alternate row background
  borderCol:  'D9E6E8',
  textMuted:  '5C7378',
};

type DocxImageType = 'jpg' | 'png' | 'gif' | 'bmp';

function contentTypeToDocxType(contentType: string): DocxImageType {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('bmp')) return 'bmp';
  return 'jpg'; // Drive thumbnails are almost always JPEG; also docx's own fallback
}

async function fetchImage(url: string): Promise<{ buffer: ArrayBuffer; type: DocxImageType } | null> {
  try {
    // Server proxy avoids CORS on Drive thumbnails; must be apiFetch since /api/* needs the bearer token.
    const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(url)}`;
    const res = await apiFetch(proxyUrl);
    if (!res.ok) return null;
    const type = contentTypeToDocxType(res.headers.get('content-type') || 'image/jpeg');
    const buffer = await res.arrayBuffer();
    return { buffer, type };
  } catch (e) {
    console.error('Failed to fetch image for docx:', url, e);
    return null;
  }
}

function parseTextRuns(text: string, opts?: { color?: string; bold?: boolean }): TextRun[] {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.filter(Boolean).map(part => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return new TextRun({ text: part.slice(2, -2), bold: true, color: opts?.color });
    }
    return new TextRun({ text: part, bold: opts?.bold, color: opts?.color });
  });
}

// Not anchored: the model sometimes adds a bullet or trailing punctuation to the image line.
const IMAGE_LINE_RE = /!\[([^\]]*)\]\((\S+?)\)/;
const TABLE_LINE_RE = /^\|(.+)\|$/;
const TABLE_SEP_RE  = /^\|[\s:|-]+\|$/;

function splitTableRow(line: string): string[] {
  return line.slice(1, -1).split('|').map(c => c.trim());
}

// docx 9.6.1 gives every ImageRun its own id generator, so all <wp:docPr id>s default to 1
// and Word drops later pictures as "needs repair". The runtime accepts an explicit id via
// `altText` (undeclared in the .d.ts, hence `as any`); one counter per document.
function makeImageIdGen(start = 100): () => number {
  let n = start;
  return () => n++;
}

function brandCell(text: string, opts: { header?: boolean; shaded?: boolean }): TableCell {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: opts.header
      ? { type: ShadingType.SOLID, color: THEME.headerBg, fill: THEME.headerBg }
      : opts.shaded
        ? { type: ShadingType.SOLID, color: THEME.stripeBg, fill: THEME.stripeBg }
        : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({
      children: parseTextRuns(text, opts.header ? { color: THEME.headerFg, bold: true } : {}),
    })],
  });
}

function buildTable(lines: string[]): Table {
  const rows = lines.map(splitTableRow).filter(cells => !cells.every(c => /^:?-+:?$/.test(c)));
  const colCount = Math.max(...rows.map(r => r.length));
  const border = { style: BorderStyle.SINGLE, size: 2, color: THEME.borderCol };

  const tableRows = rows.map((cells, ri) => {
    const isHeader = ri === 0
    const padded = Array.from({ length: colCount }, (_, i) => cells[i] ?? '')
    return new TableRow({
      tableHeader: isHeader,
      children: padded.map(cell => brandCell(cell, { header: isHeader, shaded: !isHeader && ri % 2 === 0 })),
    })
  })

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: tableRows,
  })
}

/** Markdown → docx blocks: headings, bold, bullets, tables (branded header row) and
 * inline `![alt](url)` photos with captions, matching the web view and PDF export. */
async function parseMarkdownToBlocks(text: string, nextImageId: () => number): Promise<(Paragraph | Table)[]> {
  const lines = text.split('\n');
  const blocks: (Paragraph | Table)[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Markdown table: collect the contiguous run of `|...|` lines
    if (TABLE_LINE_RE.test(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length && TABLE_LINE_RE.test(lines[i].trim())) {
        if (!TABLE_SEP_RE.test(lines[i].trim())) tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length > 0) {
        blocks.push(buildTable(tableLines));
        blocks.push(new Paragraph({ spacing: { after: 200 } }));
      }
      continue;
    }

    // Inline field photo
    const imgMatch = trimmed.match(IMAGE_LINE_RE);
    if (imgMatch) {
      const alt = imgMatch[1];
      const url = imgMatch[2].replace(/[)\].,;]+$/, '');
      const fetchUrl = getDriveThumbnailUrl(url, 'w800') ?? url;
      const image = await fetchImage(fetchUrl);
      if (image) {
        const altText = { name: alt || 'Field photo', id: nextImageId() } as unknown as { name: string };
        blocks.push(new Paragraph({
          children: [new ImageRun({ data: image.buffer, type: image.type, altText, transformation: { width: 460, height: 320 } })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: alt ? 40 : 200 },
        }));
        if (alt) {
          blocks.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [new TextRun({ text: alt, italics: true, size: 18, color: THEME.textMuted })],
          }));
        }
      }
      i++;
      continue;
    }

    if (!trimmed) {
      blocks.push(new Paragraph({ spacing: { after: 200 } }));
      i++;
      continue;
    }

    // H1 gets a page break (except the first)
    if (trimmed.startsWith('# ')) {
      if (blocks.length > 0) blocks.push(new Paragraph({ pageBreakBefore: true }));
      blocks.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
        children: [new TextRun({ text: trimmed.replace('# ', ''), bold: true, color: THEME.purpleDark, size: 36 })],
      }));
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      blocks.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 300, after: 150 },
        children: [new TextRun({ text: trimmed.replace('### ', ''), bold: true, color: THEME.teal, size: 24 })],
      }));
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: THEME.borderCol, space: 4 } },
        children: [new TextRun({ text: trimmed.replace('## ', ''), bold: true, color: THEME.purple, size: 28 })],
      }));
      i++;
      continue;
    }
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      blocks.push(new Paragraph({
        children: parseTextRuns(trimmed.slice(2)),
        bullet: { level: 0 },
        spacing: { after: 120 },
      }));
      i++;
      continue;
    }

    blocks.push(new Paragraph({
      children: parseTextRuns(trimmed),
      spacing: { after: 120 },
    }));
    i++;
  }

  return blocks;
}

function buildCoverPage(
  title: string,
  orgName = 'Jaljeevika',
  dateRange = '',
  stats?: { reportCount?: number; totalBenef?: number }
): Paragraph[] {
  const pages: Paragraph[] = []
  pages.push(new Paragraph({ spacing: { before: 1200 } }))
  pages.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({ text: orgName, bold: true, size: 28, color: THEME.purple })],
  }))
  pages.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 600 },
    children: [new TextRun({ text: title, bold: true, size: 48, color: THEME.purpleDark })],
  }))
  if (dateRange) {
    pages.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: `Period: ${dateRange}`, size: 22, color: '666666' })],
    }))
  }
  if (stats?.reportCount) {
    pages.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({ text: `Field Reports: ${stats.reportCount}`, size: 22, color: '666666' })],
    }))
  }
  if (stats?.totalBenef) {
    pages.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 1200 },
      children: [new TextRun({ text: `Beneficiaries Reached: ${stats.totalBenef.toLocaleString('en-IN')}`, size: 22, color: '666666' })],
    }))
  }
  pages.push(new Paragraph({ pageBreakBefore: true }))
  return pages
}

export async function exportToDocx(
  title: string,
  content: string,
  imageUrls: string[] = [],
  options?: { orgName?: string; dateRange?: string; totalBenef?: number; reportCount?: number }
) {
  const coverPages = buildCoverPage(
    title,
    options?.orgName,
    options?.dateRange,
    { reportCount: options?.reportCount, totalBenef: options?.totalBenef }
  )
  // Shared by every ImageRun in this document (see makeImageIdGen).
  const nextImageId = makeImageIdGen();
  const bodyBlocks = await parseMarkdownToBlocks(content, nextImageId);
  const children: (Paragraph | Table)[] = [...coverPages, ...bodyBlocks];

  // Trailing gallery only when the body embedded no photos inline, so pictures don't
  // appear twice. Same regex as the inline parser so the two agree.
  const hasInlineImages = IMAGE_LINE_RE.test(content);
  if (!hasInlineImages && imageUrls.length > 0) {
    children.push(new Paragraph({
      text: 'Field Documentation & Gallery',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 800, after: 400 },
    }));

    for (const url of imageUrls) {
      const image = await fetchImage(url);
      if (image) {
        const altText = { name: 'Field photo', id: nextImageId() } as unknown as { name: string };
        children.push(new Paragraph({
          children: [
            new ImageRun({
              data: image.buffer,
              type: image.type,
              altText,
              transformation: {
                width: 500,
                height: 350,
              },
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 200 },
        }));
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.docx`);
}
