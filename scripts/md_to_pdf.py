#!/usr/bin/env python3
"""
scripts/md_to_pdf.py
─────────────────────
Convert a markdown file to a PDF using reportlab.

Supports the subset used in docs/API.md:
  # / ## / ### / ####   headings
  paragraphs
  | tables |
  - bullet lists
  `inline code` and ```fenced blocks```
  **bold** and *italic*
  [link text](url)

Usage:
  python scripts/md_to_pdf.py docs/API.md docs/API.pdf
"""

import sys, os, re
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles  import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units   import mm
from reportlab.platypus    import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, ListFlowable, ListItem,
)
from reportlab.platypus.flowables import HRFlowable

# Brand colors (match the rest of the platform)
PURPLE = colors.HexColor('#341272')
PURPLE_LIGHT = colors.HexColor('#F5F3FB')
GREEN  = colors.HexColor('#16a34a')
AMBER  = colors.HexColor('#d97706')
RED    = colors.HexColor('#dc2626')
GRAY   = colors.HexColor('#6B7280')
GRAY_LIGHT = colors.HexColor('#F3F4F6')
BORDER = colors.HexColor('#E5E7EB')

# ── Styles ──────────────────────────────────────────────────────────────────
styles = getSampleStyleSheet()

H1 = ParagraphStyle('H1', parent=styles['Heading1'],
                    fontName='Helvetica-Bold', fontSize=22, leading=28,
                    textColor=PURPLE, spaceBefore=20, spaceAfter=12)
H2 = ParagraphStyle('H2', parent=styles['Heading2'],
                    fontName='Helvetica-Bold', fontSize=16, leading=22,
                    textColor=PURPLE, spaceBefore=16, spaceAfter=8)
H3 = ParagraphStyle('H3', parent=styles['Heading3'],
                    fontName='Helvetica-Bold', fontSize=13, leading=18,
                    textColor=colors.HexColor('#1f2937'), spaceBefore=10, spaceAfter=6)
H4 = ParagraphStyle('H4', parent=styles['Heading4'],
                    fontName='Helvetica-Bold', fontSize=11, leading=14,
                    textColor=GRAY, spaceBefore=8, spaceAfter=4)
BODY = ParagraphStyle('Body', parent=styles['BodyText'],
                      fontName='Helvetica', fontSize=10, leading=14,
                      textColor=colors.HexColor('#111827'), spaceAfter=6)
CODE = ParagraphStyle('Code', parent=BODY,
                      fontName='Courier', fontSize=9, leading=12,
                      backColor=GRAY_LIGHT, borderColor=BORDER, borderWidth=0.5,
                      borderPadding=6, spaceAfter=8, leftIndent=8, rightIndent=8)
BULLET = ParagraphStyle('Bullet', parent=BODY, leftIndent=14, bulletIndent=2)


# ── Inline formatting ────────────────────────────────────────────────────────
def inline(text: str) -> str:
    """Convert markdown inline syntax to reportlab paragraph XML."""
    # Escape XML first
    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    # Inline code `...` (must come before bold/italic to protect their contents)
    text = re.sub(r'`([^`]+)`',
                  r'<font face="Courier" size="9" backColor="#F3F4F6">\1</font>',
                  text)
    # Bold **text**
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)
    # Italic *text*
    text = re.sub(r'(?<!\*)\*([^*\n]+)\*(?!\*)', r'<i>\1</i>', text)
    # Links [label](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)',
                  r'<font color="#341272"><u><link href="\2">\1</link></u></font>',
                  text)
    return text


# ── Parse markdown into flowables ────────────────────────────────────────────
def parse_md(path: str):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.read().split('\n')

    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Horizontal rule
        if stripped == '---':
            out.append(HRFlowable(width='100%', thickness=0.6, color=BORDER,
                                  spaceBefore=8, spaceAfter=8))
            i += 1
            continue

        # Fenced code block ```
        if stripped.startswith('```'):
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1
            if code_lines:
                code_text = '<br/>'.join(
                    l.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                     .replace(' ', '&nbsp;')
                    for l in code_lines
                )
                out.append(Paragraph(code_text, CODE))
            continue

        # Headings
        m = re.match(r'^(#{1,4})\s+(.+)$', line)
        if m:
            level = len(m.group(1))
            txt = inline(m.group(2))
            out.append(Paragraph(txt, [H1, H2, H3, H4][level - 1]))
            i += 1
            continue

        # Table — detect by | at start of consecutive lines
        if stripped.startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|[\s:|-]+\|\s*$', lines[i+1]):
            header = [c.strip() for c in stripped.strip('|').split('|')]
            i += 2  # skip header + divider
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                # Pad/truncate to header width
                if len(cells) < len(header): cells += [''] * (len(header) - len(cells))
                cells = cells[:len(header)]
                rows.append(cells)
                i += 1

            # Render cells as Paragraphs so inline markdown works
            cell_style = ParagraphStyle('TblCell', parent=BODY, fontSize=9, leading=11)
            hdr_style  = ParagraphStyle('TblHdr',  parent=BODY, fontSize=9, leading=11,
                                        fontName='Helvetica-Bold', textColor=colors.white)
            data = [[Paragraph(inline(c), hdr_style) for c in header]]
            for r in rows:
                data.append([Paragraph(inline(c), cell_style) for c in r])

            t = Table(data, repeatRows=1, hAlign='LEFT')
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), PURPLE),
                ('TEXTCOLOR',  (0, 0), (-1, 0), colors.white),
                ('LINEBELOW',  (0, 0), (-1, 0), 0.5, BORDER),
                ('GRID',       (0, 1), (-1, -1), 0.25, BORDER),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, PURPLE_LIGHT]),
                ('VALIGN',     (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING',  (0, 0), (-1, -1), 4),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4),
                ('TOPPADDING',   (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING',(0, 0), (-1, -1), 3),
            ]))
            out.append(t)
            out.append(Spacer(1, 6))
            continue

        # Bullet list
        if stripped.startswith('- '):
            items = []
            while i < len(lines) and lines[i].strip().startswith('- '):
                items.append(ListItem(Paragraph(inline(lines[i].strip()[2:]), BULLET),
                                      bulletColor=PURPLE))
                i += 1
            out.append(ListFlowable(items, bulletType='bullet', leftIndent=16,
                                    bulletFontName='Helvetica', bulletFontSize=9,
                                    spaceBefore=4, spaceAfter=8))
            continue

        # Blank line
        if stripped == '':
            out.append(Spacer(1, 4))
            i += 1
            continue

        # Plain paragraph
        out.append(Paragraph(inline(stripped), BODY))
        i += 1

    return out


# ── Cover + footer ───────────────────────────────────────────────────────────
def _extract_title(md_path: str) -> str:
    """Read the first H1 from the markdown as the cover title."""
    try:
        with open(md_path, 'r', encoding='utf-8') as f:
            for line in f:
                m = re.match(r'^#\s+(.+)$', line.strip())
                if m: return m.group(1).strip()
    except Exception: pass
    return 'Documentation'


def cover_page(title: str = 'Documentation', subtitle: str = ''):
    cover = []
    cover.append(Spacer(1, 80 * mm))
    cover.append(Paragraph('<font color="#341272"><b>FieldFlow</b></font>',
                           ParagraphStyle('CoverBrand', parent=BODY,
                                          fontName='Helvetica-Bold', fontSize=48,
                                          leading=54, alignment=1)))  # center
    cover.append(Spacer(1, 10 * mm))
    # Strip "FieldFlow " prefix from the title since the brand is already shown
    clean_title = re.sub(r'^FieldFlow\s+', '', title, flags=re.IGNORECASE)
    cover.append(Paragraph(clean_title,
                           ParagraphStyle('CoverTitle', parent=BODY,
                                          fontSize=24, leading=28, alignment=1,
                                          textColor=GRAY)))
    cover.append(Spacer(1, 10 * mm))
    cover.append(HRFlowable(width='60%', thickness=1, color=PURPLE,
                            spaceBefore=12, spaceAfter=12, hAlign='CENTER'))
    if subtitle:
        cover.append(Paragraph(subtitle,
                               ParagraphStyle('CoverSub', parent=BODY,
                                              fontSize=11, leading=14, alignment=1,
                                              textColor=GRAY)))
    cover.append(PageBreak())
    return cover


_DECORATIONS = {'header': 'FieldFlow', 'source_file': ''}

def add_page_decorations(canvas, doc):
    canvas.saveState()
    # Top bar
    canvas.setFillColor(PURPLE)
    canvas.rect(0, doc.pagesize[1] - 14 * mm, doc.pagesize[0], 14 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawString(15 * mm, doc.pagesize[1] - 9 * mm, _DECORATIONS['header'])
    canvas.drawRightString(doc.pagesize[0] - 15 * mm,
                           doc.pagesize[1] - 9 * mm,
                           f'Page {doc.page}')
    # Footer divider
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(15 * mm, 12 * mm, doc.pagesize[0] - 15 * mm, 12 * mm)
    canvas.setFillColor(GRAY)
    canvas.setFont('Helvetica', 8)
    canvas.drawString(15 * mm, 7 * mm, 'chatbot-492915.el.r.appspot.com')
    canvas.drawRightString(doc.pagesize[0] - 15 * mm, 7 * mm,
                           _DECORATIONS['source_file'])
    canvas.restoreState()


# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print('Usage: python scripts/md_to_pdf.py <input.md> <output.pdf>')
        sys.exit(1)

    md_path  = sys.argv[1]
    pdf_path = sys.argv[2]

    if not os.path.exists(md_path):
        print(f'Input file not found: {md_path}')
        sys.exit(1)

    doc = SimpleDocTemplate(
        pdf_path, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=20 * mm, bottomMargin=18 * mm,
        title='FieldFlow API Reference', author='FieldFlow',
    )

    title = _extract_title(md_path)
    # Strip "FieldFlow " prefix once for header so it doesn't read "FieldFlow FieldFlow API Reference"
    header_label = 'FieldFlow ' + re.sub(r'^FieldFlow\s+', '', title, flags=re.IGNORECASE)
    _DECORATIONS['header']      = header_label
    _DECORATIONS['source_file'] = os.path.basename(md_path)
    story = cover_page(title) + parse_md(md_path)
    doc.build(story, onFirstPage=lambda c, d: None,
                     onLaterPages=add_page_decorations)

    size_kb = os.path.getsize(pdf_path) / 1024
    print(f'[OK] {pdf_path} ({size_kb:.0f} KB)')


if __name__ == '__main__':
    main()
