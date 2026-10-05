"""
FieldFlow Platform — Complete User Manual Generator
Outputs: D:/chatbot/FieldFlow_User_Manual.pdf
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm, cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, HRFlowable, KeepTogether,
)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from datetime import datetime
import os

# ── Brand colours ──────────────────────────────────────────────────────────────
PURPLE      = colors.HexColor('#341272')
DARK_PURPLE = colors.HexColor('#1D0752')
GREEN       = colors.HexColor('#16a34a')
LAVENDER    = colors.HexColor('#F5F3FB')
LIGHT_GRAY  = colors.HexColor('#F3F4F6')
MID_GRAY    = colors.HexColor('#9CA3AF')
DARK_GRAY   = colors.HexColor('#374151')
WHITE       = colors.white
AMBER       = colors.HexColor('#F59E0B')
BLUE        = colors.HexColor('#3B82F6')

W, H = A4   # 595.28 x 841.89 pts

OUT_PATH = r'D:\chatbot\FieldFlow_User_Manual.pdf'

# ── Style registry ─────────────────────────────────────────────────────────────
def build_styles():
    base = getSampleStyleSheet()

    def add(name, **kw):
        if name in base:
            base[name].__dict__.update(kw)
        else:
            base.add(ParagraphStyle(name=name, **kw))
        return base[name]

    add('Normal',    fontName='Helvetica', fontSize=10, leading=15,
        textColor=DARK_GRAY, spaceAfter=4)

    add('H1', fontName='Helvetica-Bold', fontSize=22, leading=28,
        textColor=DARK_PURPLE, spaceBefore=18, spaceAfter=8,
        borderPad=0)

    add('H2', fontName='Helvetica-Bold', fontSize=16, leading=22,
        textColor=PURPLE, spaceBefore=14, spaceAfter=6)

    add('H3', fontName='Helvetica-Bold', fontSize=12, leading=18,
        textColor=DARK_PURPLE, spaceBefore=10, spaceAfter=4)

    add('H4', fontName='Helvetica-BoldOblique', fontSize=10.5, leading=15,
        textColor=PURPLE, spaceBefore=8, spaceAfter=3)

    add('Body', fontName='Helvetica', fontSize=10, leading=16,
        textColor=DARK_GRAY, spaceAfter=6, justified=1,
        alignment=TA_JUSTIFY)

    add('Bullet', fontName='Helvetica', fontSize=10, leading=15,
        textColor=DARK_GRAY, leftIndent=18, bulletIndent=6,
        spaceAfter=3, bulletText='•')

    add('SubBullet', fontName='Helvetica', fontSize=9.5, leading=14,
        textColor=colors.HexColor('#4B5563'), leftIndent=36, bulletIndent=22,
        spaceAfter=2, bulletText='–')

    add('Note', fontName='Helvetica-Oblique', fontSize=9, leading=13,
        textColor=MID_GRAY, leftIndent=12, spaceAfter=4)

    add('Caption', fontName='Helvetica-Oblique', fontSize=8.5, leading=12,
        textColor=MID_GRAY, alignment=TA_CENTER, spaceAfter=6)

    add('TableHeader', fontName='Helvetica-Bold', fontSize=9, leading=13,
        textColor=WHITE, alignment=TA_LEFT)

    add('TableCell', fontName='Helvetica', fontSize=9, leading=13,
        textColor=DARK_GRAY, alignment=TA_LEFT)

    add('Tag', fontName='Helvetica-Bold', fontSize=8, leading=11,
        textColor=PURPLE, spaceAfter=2)

    add('TOCEntry1', fontName='Helvetica-Bold', fontSize=11, leading=16,
        textColor=DARK_PURPLE, spaceAfter=2)

    add('TOCEntry2', fontName='Helvetica', fontSize=10, leading=14,
        textColor=DARK_GRAY, leftIndent=16, spaceAfter=1)

    add('TOCEntry3', fontName='Helvetica', fontSize=9, leading=13,
        textColor=MID_GRAY, leftIndent=30, spaceAfter=1)

    return base

S = build_styles()

# ── Helper flowables ───────────────────────────────────────────────────────────
def h1(txt): return Paragraph(txt, S['H1'])
def h2(txt): return Paragraph(txt, S['H2'])
def h3(txt): return Paragraph(txt, S['H3'])
def h4(txt): return Paragraph(txt, S['H4'])
def body(txt): return Paragraph(txt, S['Body'])
def bullet(txt, sub=False):
    return Paragraph(txt, S['SubBullet'] if sub else S['Bullet'])
def note(txt): return Paragraph(f'<i>💡 {txt}</i>', S['Note'])
def sp(h=6): return Spacer(1, h)
def hr(color=PURPLE, w=0.5): return HRFlowable(width='100%', thickness=w, color=color, spaceAfter=6, spaceBefore=4)

def section_rule():
    return HRFlowable(width='100%', thickness=1.5, color=PURPLE, spaceAfter=10, spaceBefore=2)

def info_box(title, lines, bg=LAVENDER, border=PURPLE):
    """Coloured tip / info box."""
    content = [Paragraph(f'<b>{title}</b>', ParagraphStyle(
        'ib_title', fontName='Helvetica-Bold', fontSize=10, textColor=border))]
    for ln in lines:
        content.append(Paragraph(f'• {ln}', ParagraphStyle(
            'ib_body', fontName='Helvetica', fontSize=9.5, leading=14, textColor=DARK_GRAY, leftIndent=10)))
    tbl = Table([[content]], colWidths=[W - 4*cm])
    tbl.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), bg),
        ('BOX',        (0,0), (-1,-1), 1, border),
        ('LEFTPADDING', (0,0), (-1,-1), 10),
        ('RIGHTPADDING',(0,0), (-1,-1), 10),
        ('TOPPADDING',  (0,0), (-1,-1), 8),
        ('BOTTOMPADDING',(0,0), (-1,-1), 8),
        ('ROUNDEDCORNERS', [4]),
    ]))
    return tbl

def make_table(headers, rows, col_widths=None):
    """Standard data table with purple header."""
    if col_widths is None:
        avail = W - 4*cm
        col_widths = [avail / len(headers)] * len(headers)
    header_row = [Paragraph(h, S['TableHeader']) for h in headers]
    data_rows   = [[Paragraph(str(c), S['TableCell']) for c in row] for row in rows]
    tbl = Table([header_row] + data_rows, colWidths=col_widths, repeatRows=1)
    style = [
        ('BACKGROUND',   (0,0), (-1,0), PURPLE),
        ('ROWBACKGROUNDS',(0,1),(-1,-1), [WHITE, LAVENDER]),
        ('GRID',         (0,0), (-1,-1), 0.4, colors.HexColor('#E5E7EB')),
        ('LINEABOVE',    (0,0), (-1,0), 0, PURPLE),
        ('TOPPADDING',   (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0), (-1,-1), 5),
        ('LEFTPADDING',  (0,0), (-1,-1), 7),
        ('RIGHTPADDING', (0,0), (-1,-1), 7),
        ('VALIGN',       (0,0), (-1,-1), 'TOP'),
    ]
    tbl.setStyle(TableStyle(style))
    return tbl

def step_box(steps):
    """Numbered step list in a subtle box."""
    items = []
    for i, s in enumerate(steps, 1):
        items.append(Paragraph(f'<b>{i}.</b>  {s}', ParagraphStyle(
            f'step{i}', fontName='Helvetica', fontSize=10, leading=15,
            textColor=DARK_GRAY, leftIndent=14, spaceAfter=5)))
    tbl = Table([[items]], colWidths=[W - 4*cm])
    tbl.setStyle(TableStyle([
        ('BACKGROUND',   (0,0), (-1,-1), LIGHT_GRAY),
        ('BOX',          (0,0), (-1,-1), 0.5, MID_GRAY),
        ('LEFTPADDING',  (0,0), (-1,-1), 12),
        ('RIGHTPADDING', (0,0), (-1,-1), 12),
        ('TOPPADDING',   (0,0), (-1,-1), 8),
        ('BOTTOMPADDING',(0,0), (-1,-1), 8),
    ]))
    return tbl

# ── Page template (header / footer) ───────────────────────────────────────────
class PageTemplate:
    def __init__(self):
        self.page_no = 0

    def on_page(self, canv, doc):
        canv.saveState()
        pg = canv.getPageNumber()
        # Header bar (skip cover = page 1)
        if pg > 1:
            canv.setFillColor(PURPLE)
            canv.rect(0, H - 28, W, 28, fill=1, stroke=0)
            canv.setFont('Helvetica-Bold', 9)
            canv.setFillColor(WHITE)
            canv.drawString(1.5*cm, H - 18, 'FieldFlow Platform')
            canv.setFont('Helvetica', 9)
            canv.drawRightString(W - 1.5*cm, H - 18, 'User Manual  |  v1.0')
            # Footer
            canv.setFillColor(LIGHT_GRAY)
            canv.rect(0, 0, W, 22, fill=1, stroke=0)
            canv.setFillColor(MID_GRAY)
            canv.setFont('Helvetica', 8)
            canv.drawString(1.5*cm, 7, f'© {datetime.now().year} TATWA Technologies  |  Confidential')
            canv.drawRightString(W - 1.5*cm, 7, f'Page {pg}')
        canv.restoreState()

PT = PageTemplate()

# ── Cover page ─────────────────────────────────────────────────────────────────
def cover_page(canv, doc):
    canv.saveState()
    # Deep purple background
    canv.setFillColor(DARK_PURPLE)
    canv.rect(0, 0, W, H, fill=1, stroke=0)
    # Top accent strip
    canv.setFillColor(PURPLE)
    canv.rect(0, H - 6*mm, W, 6*mm, fill=1, stroke=0)
    # Bottom green strip
    canv.setFillColor(GREEN)
    canv.rect(0, 0, W, 4*mm, fill=1, stroke=0)
    # Large faded circle decoration
    canv.setFillColorRGB(1, 1, 1, alpha=0.04)
    canv.circle(W - 2*cm, H * 0.72, 9*cm, fill=1, stroke=0)
    canv.setFillColorRGB(1, 1, 1, alpha=0.03)
    canv.circle(2*cm, H * 0.28, 6*cm, fill=1, stroke=0)
    # Logo placeholder box
    canv.setFillColor(PURPLE)
    canv.roundRect(1.8*cm, H - 6*cm, 3.2*cm, 3.2*cm, 8, fill=1, stroke=0)
    canv.setFillColor(WHITE)
    canv.setFont('Helvetica-Bold', 28)
    canv.drawCentredString(3.4*cm, H - 4.9*cm, 'FF')
    # Platform name
    canv.setFillColor(WHITE)
    canv.setFont('Helvetica-Bold', 38)
    canv.drawString(1.8*cm, H - 8*cm, 'FieldFlow')
    canv.setFont('Helvetica', 22)
    canv.setFillColorRGB(1, 1, 1, alpha=0.75)
    canv.drawString(1.8*cm, H - 9.2*cm, 'Platform')
    # Tagline
    canv.setFillColor(GREEN)
    canv.setFont('Helvetica-Bold', 13)
    canv.drawString(1.8*cm, H - 10.5*cm, 'Powering Field Impact Through Data & AI')
    # Separator
    canv.setStrokeColor(PURPLE)
    canv.setLineWidth(1.5)
    canv.line(1.8*cm, H - 11.5*cm, W - 1.8*cm, H - 11.5*cm)
    # Manual title
    canv.setFillColor(WHITE)
    canv.setFont('Helvetica-Bold', 18)
    canv.drawString(1.8*cm, H - 13*cm, 'Complete User Manual')
    # Sub-details
    canv.setFont('Helvetica', 11)
    canv.setFillColorRGB(1, 1, 1, alpha=0.7)
    canv.drawString(1.8*cm, H - 14.2*cm, f'Version 1.0  |  {datetime.now().strftime("%B %Y")}')
    canv.drawString(1.8*cm, H - 15.2*cm, 'For all users: Field Staff, Managers & Administrators')
    # Feature pills
    y = H - 18*cm
    pills = ['Dashboard & Analytics', 'AI Report Generation', 'WhatsApp Platform',
             'Flow Builder', 'Content Hub', 'User Management']
    canv.setFont('Helvetica', 9)
    x = 1.8*cm
    for pill in pills:
        pw = canv.stringWidth(pill, 'Helvetica', 9) + 18
        canv.setFillColor(PURPLE)
        canv.roundRect(x, y, pw, 16, 4, fill=1, stroke=0)
        canv.setFillColor(WHITE)
        canv.drawString(x + 9, y + 4, pill)
        x += pw + 8
        if x > W - 4*cm:
            x = 1.8*cm; y -= 24
    # Bottom note
    canv.setFillColorRGB(1, 1, 1, alpha=0.4)
    canv.setFont('Helvetica', 8)
    canv.drawCentredString(W/2, 1.6*cm, 'TATWA Technologies  •  Confidential & Proprietary')
    canv.restoreState()


# ── Content builder ────────────────────────────────────────────────────────────
def build_story():
    story = []

    # ── 1. Introduction ───────────────────────────────────────────────────────
    story += [h1('1. Introduction'), section_rule()]
    story.append(body(
        'FieldFlow is a cloud-based field-operations platform built for NGOs, social enterprises, '
        'and development-sector organisations. It connects field staff collecting data on the ground '
        'with managers and administrators who need real-time insight, AI-generated reports, and '
        'WhatsApp-based engagement with beneficiaries.'
    ))
    story.append(sp(4))
    story.append(info_box('What FieldFlow does for you', [
        'Aggregates field reports submitted via mobile in real time',
        'Provides instant dashboards — beneficiary reach, project progress, geographic coverage',
        'Generates AI-written reports, impact stories, social posts, and more in seconds',
        'Manages a WhatsApp chatbot that collects data and sends messages automatically',
        'Controls who sees what with role-based access and per-user overrides',
    ]))
    story.append(sp(8))

    story.append(h2('1.1  Who This Manual Is For'))
    story.append(make_table(
        ['Role', 'Typical Job Title', 'Key Use Cases'],
        [
            ['Field Staff / Employee', 'Field Officer, CRP, Promoter',
             'Submit reports, view own dashboard, access impact data'],
            ['Manager / Team Leader', 'Project Manager, Cluster Head',
             'Monitor team activity, generate team/project reports, manage WhatsApp flows'],
            ['Admin / Organisation Lead', 'Director, MIS Officer, IT Admin',
             'Full platform control — settings, user management, AI configuration, billing'],
        ],
        col_widths=[3.5*cm, 5*cm, 7.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('1.2  Key Concepts'))
    for term, defn in [
        ('Field Report',   'A structured data entry submitted by a field worker — includes location, project, beneficiary count, activity description, and optional photo.'),
        ('Project',        'A named programme or intervention (e.g. "WetlandRestore_Odisha"). Reports are tagged to a project for filtering and analysis.'),
        ('Content Hub',    'The AI content-generation interface — turns your field data into polished reports, stories, and social posts.'),
        ('WhatsApp Flow',  'An automated chatbot conversation tree that runs on your WhatsApp Business number — collects data, sends messages, and routes contacts.'),
        ('Organisation',   'Your registered entity in FieldFlow. All data, users, and settings are scoped to your organisation.'),
        ('Role',           'Determines what a user can see and do: Employee < Manager < Admin < Superadmin.'),
    ]:
        story.append(KeepTogether([
            Paragraph(f'<b>{term}</b>', ParagraphStyle('term', fontName='Helvetica-Bold', fontSize=10,
                textColor=PURPLE, spaceBefore=6, spaceAfter=1)),
            Paragraph(defn, S['Body']),
        ]))
    story.append(PageBreak())

    # ── 2. Getting Started ────────────────────────────────────────────────────
    story += [h1('2. Getting Started'), section_rule()]

    story.append(h2('2.1  Logging In'))
    story.append(body(
        'FieldFlow uses Google or email-based authentication via Firebase. '
        'Your administrator will share your login credentials or invite you by email.'
    ))
    story.append(step_box([
        'Open your browser and go to your organisation\'s FieldFlow URL.',
        'Click <b>Sign in with Google</b> or enter your email and password.',
        'If this is your first login, you may be prompted to set a new password.',
        'You will land on the <b>Overview dashboard</b> after a successful login.',
    ]))
    story.append(sp(8))
    story.append(note('If you see "Not configured — go to Settings", ask your Admin to complete the WhatsApp setup. Your dashboard will still work normally.'))
    story.append(sp(8))

    story.append(h2('2.2  Navigation'))
    story.append(body(
        'The main navigation is a <b>left sidebar</b> that lists all tabs you have access to. '
        'Tabs shown depend on your role and what your administrator has enabled.'
    ))
    story.append(make_table(
        ['Tab', 'Icon', 'Who Can See It', 'Purpose'],
        [
            ['Overview',    '📊', 'All roles',         'Dashboard KPIs, charts, recent activity'],
            ['Reports',     '📋', 'All roles',         'Full list of field reports with filters'],
            ['Media',       '🖼️', 'All roles',         'Photo gallery from field attachments'],
            ['Impact',      '🌱', 'Manager, Admin',    'Theory of Change and outcome analysis'],
            ['ToC Analysis','🔀', 'Manager, Admin',    'Detailed Theory of Change mapping'],
            ['Analytics',   '📈', 'All roles',         'Worker performance and team leaderboards'],
            ['Notebook',    '🤖', 'All roles',         'AI research workspace with sources and chat'],
            ['WhatsApp',    '💬', 'Admin only',        'Full WhatsApp Business Platform management'],
            ['Settings',    '⚙️', 'Admin only',        'Organisation configuration and user management'],
        ],
        col_widths=[2.8*cm, 1.2*cm, 3.5*cm, 8.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('2.3  Applying Filters'))
    story.append(body(
        'A universal <b>filter bar</b> at the top of the dashboard applies to the Overview, Reports, '
        'Media, Impact, and Notebook tabs simultaneously.'
    ))
    story.append(make_table(
        ['Filter', 'Type', 'What It Does'],
        [
            ['Project',             'Multi-select',  'Show only data from the selected project(s)'],
            ['State',               'Multi-select',  'Limit to one or more states'],
            ['Area of Intervention','Multi-select',  'Filter by programme category (e.g. Livelihoods, Health)'],
            ['Worker Name',         'Multi-select',  'Show only reports by selected team members'],
            ['Date Range',          'Date picker',   'From / To — filters all metrics to that period'],
        ],
        col_widths=[4*cm, 3*cm, 9*cm]
    ))
    story.append(sp(4))
    story.append(note('Filters persist within your session. Refresh the page or click "Clear Filters" to reset.'))
    story.append(PageBreak())

    # ── 3. Overview Dashboard ─────────────────────────────────────────────────
    story += [h1('3. Overview Dashboard'), section_rule()]
    story.append(body(
        'The Overview is your daily command centre. It updates in real time as field reports come in '
        'and gives you an instant picture of field activity, beneficiary reach, and data quality.'
    ))
    story.append(sp(6))

    story.append(h2('3.1  Hero Stat Cards'))
    story.append(make_table(
        ['Card', 'What It Shows', 'Colour'],
        [
            ['Field Reports',       'Total reports in the selected filter period vs. all available, with % completion',   'Purple'],
            ['Outreach',            'Sum of beneficiaries reached — the most important impact number',                    'Green'],
            ['Projects',            'Count of distinct projects with at least one report in the period',                 'Blue'],
            ['States',              'Geographic spread — unique states with field activity',                              'Indigo'],
            ['Photos',              'Reports with image attachments (indicator of documentation quality)',               'Amber'],
        ],
        col_widths=[3.5*cm, 10*cm, 2.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('3.2  14-Day Activity Chart'))
    story.append(body(
        'A dual-bar chart shows the last 14 calendar days. '
        'Dark bars = number of field reports. Green bars = total beneficiaries. '
        'Hover over any bar to see the exact count and date.'
    ))
    story.append(sp(8))

    story.append(h2('3.3  Operational Health KPIs'))
    story.append(make_table(
        ['KPI', 'Formula', 'Green Threshold'],
        [
            ['Data Collection Rate',     'Days with ≥1 report ÷ total days in period',         '≥ 80 %'],
            ['Avg Beneficiaries/Report', 'Total beneficiaries ÷ total reports',                '—'],
            ['Active Contributor Rate',  'Unique submitters in period ÷ total known staff',    '≥ 70 %'],
            ['Top Project',              'Project with the most reports in the period',         '—'],
        ],
        col_widths=[5*cm, 7.5*cm, 3.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('3.4  Data Quality Scorecard'))
    story.append(body('Colour-coded bars show the quality of your incoming field data:'))
    story.append(make_table(
        ['Metric', 'Definition', '🟢 Good', '🟡 Fair', '🔴 Poor'],
        [
            ['Photo Coverage',            '% of reports with an image attached',            '≥ 80 %', '50–79 %', '< 50 %'],
            ['Description Completeness',  '% of reports with description ≥ 30 characters',  '≥ 80 %', '50–79 %', '< 50 %'],
            ['Contributor Consistency',   '% of last-week contributors active this week',    '≥ 80 %', '50–79 %', '< 50 %'],
        ],
        col_widths=[5*cm, 6*cm, 2*cm, 2*cm, 2*cm]
    ))
    story.append(sp(8))

    story.append(h2('3.5  Top Contributors Leaderboard'))
    story.append(body(
        'Visible to Managers and Admins. Shows the top 6 field staff by report count '
        'for the current filter period, with total outreach figures. '
        'Gold/Silver/Bronze medals are awarded to the top 3.'
    ))
    story.append(sp(8))

    story.append(h2('3.6  Recent Activity Feed'))
    story.append(body(
        'The bottom section shows the 6 most recent field entries with: contributor name, '
        'state, project, description snippet, beneficiary count, photo indicator, and date. '
        'Click any entry to open the full report.'
    ))
    story.append(PageBreak())

    # ── 4. Field Reports ──────────────────────────────────────────────────────
    story += [h1('4. Field Reports'), section_rule()]
    story.append(body(
        'The Reports tab lists every field report that matches your current filters. '
        'Each card shows the core data fields submitted by the field worker.'
    ))
    story.append(sp(6))

    story.append(h2('4.1  Report Card Fields'))
    story.append(make_table(
        ['Field', 'Description'],
        [
            ['Worker Name & Phone',   'Who submitted the report (linked to their user profile)'],
            ['Timestamp',             'Date and time of submission'],
            ['Project',               'Which programme this report belongs to'],
            ['State',                 'Geographic state where the activity took place'],
            ['Area of Intervention',  'Type of work (e.g. Training, Survey, Meeting, Distribution)'],
            ['Beneficiaries',         'Number of people directly reached or served'],
            ['Description',           'Free-text narrative of what was done, observed, and achieved'],
            ['Photo',                 'Thumbnail of attached image (if any); click to view full size'],
        ],
        col_widths=[4.5*cm, 11.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('4.2  Searching and Filtering Reports'))
    story.append(body(
        'Use the universal filter bar to narrow reports by project, state, worker, or date range. '
        'Use the search box (if present) to find reports containing specific keywords in the description.'
    ))
    story.append(sp(8))

    story.append(h2('4.3  Generating AI Reports from Field Data'))
    story.append(body(
        'Any filtered view of reports can be turned into a polished document in seconds. '
        'Click the <b>Content Hub</b> or <b>Generate Report</b> button on the Overview page.'
    ))
    story.append(step_box([
        'Apply any desired filters (project, date range, worker, etc.).',
        'Click <b>Generate Report</b> or open the <b>Content Hub</b>.',
        'Choose a report type (Self, Team, Project, Impact, etc.).',
        'Optionally add custom instructions or a focus area.',
        'Click <b>Generate</b>. The AI drafts the report in ~15–30 seconds.',
        'Review, edit, copy, or download as <b>Word (.docx)</b> or <b>PDF</b>.',
        'Click <b>Save</b> to store the report in your organisation\'s library.',
    ]))
    story.append(PageBreak())

    # ── 5. Content Hub & AI Reports ───────────────────────────────────────────
    story += [h1('5. Content Hub & AI Report Generation'), section_rule()]
    story.append(body(
        'The Content Hub is FieldFlow\'s AI writing engine. It reads your filtered field data '
        'and produces publication-ready documents — no copy-pasting or manual formatting required.'
    ))
    story.append(sp(6))

    story.append(h2('5.1  Report Types'))
    story.append(make_table(
        ['Report Type', 'Who Can Generate', 'Description'],
        [
            ['Self Report',        'Employee, Manager, Admin',
             'Monthly activity report for an individual staff member — objectives, activities, outcomes, learnings, and next month plan.'],
            ['Team Report',        'Manager, Admin',
             'Aggregated monthly report for a manager\'s team — includes individual contribution table, collective impact, and team development needs.'],
            ['Project Report',     'Manager, Admin',
             'Deep-dive by project and area of intervention — cross-project comparisons, donor-ready narrative.'],
            ['Organisational Report', 'Admin only',
             'Executive-level board report covering the full organisation — national scale, all projects, Sopact-aligned structure.'],
            ['Impact Report',      'Employee, Manager, Admin',
             'Human-focused narrative quantifying beneficiary reach with case study narratives.'],
        ],
        col_widths=[3.5*cm, 3.5*cm, 9*cm]
    ))
    story.append(sp(10))

    story.append(h2('5.2  Content Types'))
    story.append(make_table(
        ['Content Type', 'Who Can Generate', 'Description'],
        [
            ['Story',          'Manager, Admin',
             'Mines field data for the single most powerful human interest story using the Nonprofit Storytelling Conference framework.'],
            ['Video Overview', 'Manager, Admin',
             'Frame-by-frame video script with visual descriptions, scene duration, and narration — integrates with Google Drive media.'],
            ['Study Guide',    'Manager, Admin',
             'Educational resource for partners and donors — learning objectives, key takeaways, comprehension questions.'],
            ['Audio Overview', 'Manager, Admin',
             'Podcast / audio narrative script optimised for remote audiences with limited internet.'],
        ],
        col_widths=[3.5*cm, 3.5*cm, 9*cm]
    ))
    story.append(sp(10))

    story.append(h2('5.3  Social Media Posts'))
    story.append(body(
        'Generate platform-optimised social posts from your field data with the Social Post generator.'
    ))
    story.append(make_table(
        ['Option', 'Choices'],
        [
            ['Platform',  'Instagram, Facebook, X / Twitter, LinkedIn'],
            ['Tone',      'Inspiring, Celebratory, Professional, Urgent'],
            ['Output',    'Post text + suggested hashtags + call-to-action + photo carousel from field attachments'],
        ],
        col_widths=[3.5*cm, 12.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('5.4  Saved Reports Library'))
    story.append(body(
        'Every generated report can be saved to your organisation\'s library. '
        'Access it from <b>Settings → Saved Reports</b>.'
    ))
    story.append(make_table(
        ['Action', 'How To'],
        [
            ['Save report',   'Click <b>Save</b> button after generation'],
            ['View saved',    'Settings → Saved Reports → click any card'],
            ['Download',      'Click the download icon → choose Word or Text'],
            ['Copy to clipboard', 'Click the copy icon on any saved report card'],
            ['Delete',        'Click the trash icon (cannot be undone)'],
        ],
        col_widths=[4.5*cm, 11.5*cm]
    ))
    story.append(PageBreak())

    # ── 6. AI Notebook ────────────────────────────────────────────────────────
    story += [h1('6. AI Notebook (Research Workspace)'), section_rule()]
    story.append(body(
        'The Notebook is a three-panel AI research workspace where you can load field data as '
        '"sources", ask questions in a chat, and compile a structured output document — all in one screen.'
    ))
    story.append(sp(6))

    story.append(h2('6.1  Three-Panel Layout'))
    story.append(make_table(
        ['Panel', 'Purpose', 'Key Actions'],
        [
            ['Left — Sources',    'Load the data the AI will reason about',
             'Add reports, add filtered sets, drag to reorder, remove source'],
            ['Centre — Chat',     'Conversational AI that reasons over your sources',
             'Type a question, use starter prompts, stream response in real time'],
            ['Right — Output',    'Auto-compiled document as you chat',
             'Copy as markdown, download, export to Word (.docx)'],
        ],
        col_widths=[4*cm, 5*cm, 7*cm]
    ))
    story.append(sp(8))

    story.append(h2('6.2  Starter Prompts'))
    story.append(body('Click any of these to get an instant analysis:'))
    for p in ['Summarise recent field activity',
              'What patterns appear across the data?',
              'Identify the top challenges faced by field staff',
              'Which project has the highest beneficiary reach?',
              'What recommendations can you make from this data?']:
        story.append(bullet(p))
    story.append(sp(8))

    story.append(h2('6.3  On Mobile'))
    story.append(body(
        'On smaller screens, the three panels collapse into a single view with a '
        'bottom tab bar: <b>Sources | Chat | Output</b>. '
        'Switch between tabs to access each panel.'
    ))
    story.append(PageBreak())

    # ── 7. Impact & ToC Analysis ──────────────────────────────────────────────
    story += [h1('7. Impact & Theory of Change Analysis'), section_rule()]
    story.append(body(
        'The Impact tab and ToC Analysis tab use AI to extract outcome evidence from '
        'your field reports and map it against a Theory of Change framework.'
    ))
    story.append(sp(6))

    story.append(h2('7.1  Impact Dashboard Sections'))
    story.append(make_table(
        ['Section', 'Description'],
        [
            ['Theory of Change Distribution', 'Bar chart showing how many field entries relate to each ToC level: Activity → Output → Outcome → Impact'],
            ['Quantitative Evidence',         'Key numerical insights extracted from the data — beneficiary counts, income changes, training completions'],
            ['Change Pathway Narrative',      'AI-written story of how activities are creating outcomes, based on the field evidence'],
            ['Common Themes',                 'Recurring topics and keywords across field descriptions'],
            ['Top Barriers',                  'Obstacles mentioned by field staff with severity levels (High / Medium / Low)'],
            ['Learnings & Recommendations',   'What worked, what to improve, and suggested next steps'],
            ['Breakdowns by Area/Project/State/Month', 'Bar charts and tables showing distribution of impact indicators'],
        ],
        col_widths=[5.5*cm, 10.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('7.2  Using the Impact Tab'))
    story.append(step_box([
        'Apply date range and project filters in the filter bar.',
        'Navigate to the <b>Impact</b> tab in the sidebar.',
        'Scroll through each section — charts load as data is analysed.',
        'To generate a full Impact Report document, click <b>Generate Report</b> from any tab.',
    ]))
    story.append(PageBreak())

    # ── 8. Analytics ─────────────────────────────────────────────────────────
    story += [h1('8. Analytics & Performance Review'), section_rule()]
    story.append(body(
        'The Analytics tab provides per-worker and team-level performance metrics. '
        'Managers and Admins use this to identify high performers, gaps in coverage, '
        'and field-team consistency.'
    ))
    story.append(sp(6))

    story.append(h2('8.1  Worker Scorecard Metrics'))
    story.append(make_table(
        ['Metric', 'Definition'],
        [
            ['Report Submission Rate',   'Reports submitted ÷ working days in period'],
            ['Photo / Documentation Rate', '% of this worker\'s reports that include a photo'],
            ['Average Beneficiaries',    'Mean beneficiaries per report for this worker'],
            ['Field Days Frequency',     'How often (per week) this worker submits'],
            ['Primary Areas',            'Top areas of intervention by count'],
            ['Associated Projects',      'Projects this worker has reported under'],
            ['Reporting Consistency',    'Week-over-week repeat rate — are they reporting regularly?'],
        ],
        col_widths=[5.5*cm, 10.5*cm]
    ))
    story.append(sp(8))

    story.append(h2('8.2  Team-Level Trends'))
    story.append(body(
        'At the top of the Analytics tab, team aggregate views show:'
    ))
    for item in ['Total active workers in the period',
                 'Reports per worker — distribution histogram',
                 'Outreach per worker',
                 'Top performers leaderboard',
                 'Geographic distribution — state-wise and area-wise worker deployment']:
        story.append(bullet(item))
    story.append(PageBreak())

    # ── 9. WhatsApp Platform ─────────────────────────────────────────────────
    story += [h1('9. WhatsApp Platform'), section_rule()]
    story.append(body(
        'FieldFlow includes a full WhatsApp Business Cloud API integration. '
        'Admins can build automated chatbot flows, view live conversations, '
        'manage contacts, and send broadcasts — all from the WhatsApp tab.'
    ))
    story.append(sp(6))

    story.append(h2('9.1  Overview Tab'))
    story.append(body('The WhatsApp Overview shows six live statistics:'))
    story.append(make_table(
        ['Stat Card', 'Description'],
        [
            ['Contacts',            'Total unique WhatsApp contacts who have messaged your number'],
            ['Inbound Messages',    'Messages received from contacts'],
            ['Outbound Messages',   'Messages sent by the platform (bot + agent)'],
            ['Active Flows',        'Published flows currently accepting trigger keywords'],
            ['Active Sessions',     'Contacts in the middle of a flow conversation right now'],
            ['Completed Sessions',  'Total finished flow journeys'],
        ],
        col_widths=[4.5*cm, 11.5*cm]
    ))
    story.append(sp(10))

    story.append(h2('9.2  Conversations Tab'))
    story.append(body(
        'A Glific-inspired two-panel view for live agent monitoring and manual messaging.'
    ))
    story += [
        h3('Left Panel — Contact List'),
        bullet('Search contacts by name or phone'),
        bullet('Filter by status: All / 🤖 Active Bot Session / ✅ Opted-in'),
        bullet('Each row shows: name, phone, last message preview, time ago, active flow badge'),
        sp(6),
        h3('Right Panel — Conversation View'),
        bullet('WhatsApp-style chat bubbles — inbound messages on the left, outbound on the right'),
        bullet('Bot messages in purple, manual agent replies in teal'),
        bullet('Session status bar shows: current flow name, current node, time in session'),
        bullet('<b>Stop Bot</b> button — removes the active session so an agent can take over'),
        bullet('<b>Tags</b> — add or remove contact labels directly from the conversation header'),
        bullet('<b>Collected Fields</b> — view data saved by the bot (name, village, answers, etc.)'),
        bullet('<b>Compose box</b> — type a message and press Enter to send as agent reply (Shift+Enter for new line)'),
        sp(4),
        note('Conversations auto-refresh every 20 seconds. New messages appear without reloading.'),
    ]
    story.append(sp(10))

    story.append(h2('9.3  Flows Tab'))
    story.append(body(
        'Flows are automated conversation trees triggered by keywords. '
        'The Flows tab lists all your flows with status and actions.'
    ))
    story.append(make_table(
        ['Column / Badge', 'Description'],
        [
            ['Flow Name',       'Name you gave the flow'],
            ['ACTIVE badge',    'Green = published and accepting triggers. Grey = draft, not active.'],
            ['DEFAULT badge',   'Blue = this flow runs when no specific keyword is matched'],
            ['Nodes count',     'Number of steps in the flow'],
            ['Trigger keywords','Keywords that start this flow (e.g. "hi", "hello", "report")'],
            ['Updated date',    'Last time the flow was edited'],
        ],
        col_widths=[4*cm, 12*cm]
    ))
    story.append(sp(8))

    story.append(h3('Flow Actions'))
    story.append(make_table(
        ['Button', 'Action'],
        [
            ['▶ Simulate',     'Open the built-in simulator to test the flow without sending real messages'],
            ['⏸ / ▶ Toggle',   'Activate (publish) or deactivate (pause) the flow'],
            ['✏ Edit',         'Open the Flow Builder to modify nodes and connections'],
            ['🗑 Delete',       'Permanently remove the flow (asks for confirmation)'],
            ['📋 Templates',   'Open the template gallery to start from a pre-built flow'],
            ['+ New Flow',     'Create a blank flow from scratch'],
        ],
        col_widths=[3.5*cm, 12.5*cm]
    ))
    story.append(sp(10))

    story.append(h2('9.4  Flow Builder — Mind-Map Editor'))
    story.append(body(
        'The Flow Builder is a visual canvas editor where you drag, connect, and configure nodes '
        'to build your chatbot conversation. It works like a mind-map — nodes are cards on an '
        'infinite canvas connected by arrows.'
    ))
    story.append(sp(6))

    story.append(h3('Canvas Controls'))
    story.append(make_table(
        ['Action', 'How To'],
        [
            ['Pan canvas',      'Click and drag on empty canvas space'],
            ['Zoom in / out',   'Scroll wheel, or use the + / - controls in the bottom-left'],
            ['Add a node',      'Click the purple <b>+ Add Node</b> button at the bottom centre'],
            ['Select a node',   'Click any node card — the right panel opens for editing'],
            ['Move a node',     'Click and drag the node card to reposition it'],
            ['Connect nodes',   'Drag from the bottom handle (circle) of one node to the top handle of another'],
            ['Delete a node',   'Select it, then press the <b>Delete</b> key, or click the trash icon in the right panel'],
            ['Delete an edge',  'Click the edge (arrow) to select it, then press the <b>Delete</b> key'],
            ['Mini-map',        'Bottom-right corner — shows all nodes; click to navigate'],
        ],
        col_widths=[4*cm, 12*cm]
    ))
    story.append(sp(10))

    story.append(h3('Node Types Reference'))
    story.append(make_table(
        ['Node Type', 'Icon', 'Purpose', 'Key Fields'],
        [
            ['Send Message',  '💬', 'Send a plain text message',
             'Message text (supports {{variable}} placeholders), Next node'],
            ['List Selection','📋', 'Interactive scrollable list (up to 10 options)',
             'Header, Body text, Section title, Options (id, title, description), Save as, Next node'],
            ['Button Choice', '🔘', 'Up to 3 quick-reply buttons',
             'Body text, Buttons (up to 3, 20 chars each), Save as, Next node'],
            ['Wait for Input','✏️', 'Wait for the user to type a free-text reply',
             'Prompt text, Save as (variable name), Validation (text/number/phone), Next node'],
            ['Condition',     '🔀', 'Branch based on a variable\'s value',
             'Variable, Operator (equals/contains/starts_with/not_empty/is_number), Value, Next if TRUE, Next if FALSE'],
            ['Webhook Call',  '🌐', 'Call an external API and store the response',
             'Method (POST/GET), URL, Request body (key-value), Headers, Next on success, Next on error'],
            ['Set Variable',  '📌', 'Store a fixed value in a contact field',
             'Field name, Value (literal or {{variable}})'],
            ['Delay / Wait',  '⏱️', 'Pause before continuing',
             'Duration in seconds (1–3600)'],
            ['Add Label',     '🏷️', 'Tag the contact with a label/collection',
             'Label name'],
            ['Enter Sub-Flow','↗️', 'Transfer contact to a different flow',
             'Sub-flow name'],
            ['End Flow',      '🔚', 'Close the session',
             'Optional farewell message'],
        ],
        col_widths=[3*cm, 1*cm, 4.5*cm, 7.5*cm]
    ))
    story.append(sp(8))

    story.append(h3('Connecting Nodes'))
    story.append(body(
        'Each node has a <b>target handle</b> (grey circle at the top) and one or more '
        '<b>source handles</b> (coloured circles at the bottom). '
        'Drag from a source handle to a target handle to create an arrow.'
    ))
    story.append(make_table(
        ['Handle Colour', 'Node Type', 'Meaning'],
        [
            ['Grey',   'All regular nodes',   'Default next node'],
            ['Green ✅', 'Condition, Webhook', 'TRUE path / Success path'],
            ['Red ❌',   'Condition',          'FALSE path'],
            ['Amber ⚠️', 'Webhook',            'Error path (API call failed)'],
        ],
        col_widths=[3*cm, 4*cm, 9*cm]
    ))
    story.append(sp(8))

    story.append(h3('Variable Placeholders'))
    story.append(body(
        'In any text field, use <b>{{variable_name}}</b> to insert data collected earlier in the flow. '
        'FieldFlow also provides built-in contact variables:'
    ))
    story.append(make_table(
        ['Placeholder', 'Value'],
        [
            ['{{contact.name}}',   'The contact\'s display name (from WhatsApp profile)'],
            ['{{contact.wa_id}}',  'The contact\'s WhatsApp phone number'],
            ['{{your_variable}}',  'Any value saved by a Wait for Input, List, or Button node'],
            ['{{webhook_key}}',    'A key from the last Webhook response JSON'],
        ],
        col_widths=[5*cm, 11*cm]
    ))
    story.append(sp(8))

    story.append(h3('Saving and Publishing a Flow'))
    story.append(step_box([
        'Set the <b>Flow Name</b> in the toolbar (top-left input).',
        'Add <b>Trigger Keywords</b> (comma-separated) — e.g. "hi, hello, start".',
        'Build your node graph on the canvas.',
        'Click <b>Save Flow</b> (purple button, top-right).',
        'Back in the Flows list, click the <b>▶ Activate</b> button to publish it.',
        'The flow will now respond to incoming WhatsApp messages that match your keywords.',
    ]))
    story.append(sp(10))

    story.append(h2('9.5  Flow Templates'))
    story.append(body(
        'Click <b>Templates</b> in the Flows header to open the pre-built template gallery. '
        'Select a template to pre-fill a new flow — you can edit everything after loading.'
    ))
    story.append(make_table(
        ['Template', 'Tags', 'Description'],
        [
            ['Welcome & Registration',    'onboarding, registration',
             'Greets new contacts, shows a main menu, and routes to sub-flows'],
            ['Field Report Collection',   'field, reporting',
             '8-node flow collecting village, beneficiaries, activity type, description, and submitting via webhook'],
            ['Beneficiary Survey',        'survey, feedback, M&E',
             'Satisfaction rating, income change, and open comment collection'],
            ['Opt-out Handler',           'compliance, opt-out',
             'Handles STOP / unsubscribe keywords, marks contact as opted out'],
            ['Quick Poll / Quiz',         'poll, quiz, engagement',
             '3-button single-question poll with label tagging'],
        ],
        col_widths=[4.5*cm, 3.5*cm, 8*cm]
    ))
    story.append(sp(10))

    story.append(h2('9.6  Flow Simulator'))
    story.append(body(
        'Click the green <b>🎬 Simulate</b> button on any flow card (or inside the builder) to '
        'test your flow without sending real WhatsApp messages.'
    ))
    story.append(make_table(
        ['Simulator Feature', 'Description'],
        [
            ['Chat preview',    'See exactly what messages the contact will receive at each step'],
            ['Button / List interaction', 'Click buttons and list options as if you were the contact'],
            ['Free-text input', 'Type your own text to test Wait for Input nodes and condition branches'],
            ['Variable display', 'Watch variables fill in as the conversation progresses'],
            ['Reset',           'Start the flow from the beginning at any time'],
        ],
        col_widths=[5*cm, 11*cm]
    ))
    story.append(sp(10))

    story.append(h2('9.7  Contacts Tab'))
    story.append(body(
        'All WhatsApp contacts who have ever messaged your number are stored here.'
    ))
    story.append(make_table(
        ['Column', 'Description'],
        [
            ['Avatar / Initial',  'Auto-generated coloured avatar based on phone number'],
            ['Name',              'Contact\'s WhatsApp display name (or phone number if no name)'],
            ['Phone (wa_id)',     'WhatsApp phone number in international format'],
            ['OPT-IN badge',      'Green badge if the contact has opted in to receive messages'],
            ['Message count',     'Total messages exchanged with this contact'],
            ['Tags',              'Labels applied by flows or agents (shown as coloured pills)'],
        ],
        col_widths=[3.5*cm, 12.5*cm]
    ))
    story.append(sp(6))
    story.append(body(
        'Click any contact to open a side drawer showing their full message history and '
        'all data fields collected by flows.'
    ))
    story.append(sp(10))

    story.append(h2('9.8  Broadcast Tab'))
    story.append(body(
        'Send a message to multiple contacts at once — useful for announcements, reminders, and campaigns.'
    ))
    story.append(step_box([
        'Go to WhatsApp → <b>Broadcast</b> tab.',
        'Choose recipients: <b>All contacts</b>, <b>By label/tag</b>, or <b>By opt-in status</b>.',
        'Compose your message (text, template, or media).',
        'Choose <b>Send Now</b> or set a scheduled time.',
        'Click <b>Send Broadcast</b>. Delivery status is tracked per contact.',
    ]))
    story.append(sp(6))
    story.append(info_box('Broadcast Best Practices', [
        'Only send to opted-in contacts to comply with WhatsApp Business Policy.',
        'Use approved message templates for outbound-initiated messages.',
        'Keep message frequency reasonable — avoid daily broadcasts.',
        'Monitor delivery and read rates in the broadcast report.',
    ], bg=colors.HexColor('#ECFDF5'), border=GREEN))
    story.append(sp(10))

    story.append(h2('9.9  WhatsApp Settings'))
    story.append(body(
        'Configure your WhatsApp Business API connection. '
        'These settings must be completed by an Admin before any WhatsApp features will work.'
    ))
    story.append(make_table(
        ['Setting', 'Where to Get It', 'Description'],
        [
            ['Phone Number ID',    'Meta Business Manager → WhatsApp → Phone Numbers',
             'The numeric ID of your registered WhatsApp Business phone number'],
            ['Business Account ID','Meta Business Manager → Business Settings → WhatsApp Accounts',
             'Your WhatsApp Business Account (WABA) ID'],
            ['Access Token',       'Meta Business Manager → System Users → Generate Token',
             'A permanent "System User" token with whatsapp_business_messaging permission'],
            ['Webhook Verify Token','FieldFlow Settings → WhatsApp',
             'A secret string you set; enter the same value in the Meta Webhook configuration'],
        ],
        col_widths=[4*cm, 5.5*cm, 6.5*cm]
    ))
    story.append(sp(6))
    story.append(note('Use a System User token (not a personal token) — it never expires. Personal tokens expire every 60 days.'))
    story.append(PageBreak())

    # ── 10. Settings & Administration ─────────────────────────────────────────
    story += [h1('10. Settings & Administration'), section_rule()]
    story.append(body(
        'The Settings tab is only visible to Admins. It is the control panel for your '
        'organisation — managing users, projects, permissions, AI behaviour, and more.'
    ))
    story.append(sp(6))

    story.append(h2('10.1  User Management'))
    story.append(h3('Viewing the User Directory'))
    story.append(body('The user list shows every team member with:'))
    for col in ['Name, email, phone',
                'Role badge (Admin / Manager / Employee)',
                'Report count and total beneficiaries (last 90 days)',
                'Last active date',
                'States worked in']:
        story.append(bullet(col))
    story.append(sp(6))

    story.append(h3('Adding a New User'))
    story.append(step_box([
        'Click <b>+ Add User</b>.',
        'Enter: Name, Phone (10-digit Indian mobile), Role, Manager (for Employees), State.',
        'Set a temporary password (user can change it on first login).',
        'Click <b>Save</b>. The user can now log in immediately.',
    ]))
    story.append(sp(8))

    story.append(h3('Editing a User'))
    story.append(body('Click the edit (✏) icon on any user card to update name, role, manager assignment, state, or projects.'))
    story.append(sp(6))

    story.append(h3('Deactivating a User'))
    story.append(body(
        'Toggle the <b>Active</b> switch to deactivate a user. '
        'They will no longer be able to log in, but their report history is preserved. '
        'Deactivated users appear in grey in the user list.'
    ))
    story.append(sp(6))

    story.append(h3('Merging Duplicate Users'))
    story.append(body(
        'If the same field worker has submitted reports under two different phone numbers, '
        'click <b>Merge Duplicate</b> and select the secondary phone to consolidate. '
        'All reports from the secondary record are moved to the primary and the duplicate is removed.'
    ))
    story.append(sp(10))

    story.append(h2('10.2  Projects'))
    story.append(body(
        'Projects are the top-level grouping for field reports. '
        'Every report must belong to a project. Admins manage the project master list here.'
    ))
    story.append(step_box([
        'Go to <b>Settings → Projects</b>.',
        'Click <b>+ Add Project</b>.',
        'Enter a Project ID (lowercase, no spaces — e.g. "wetland_odisha") and Display Name.',
        'Choose a colour for visual distinction in charts and filters.',
        'Click <b>Save</b>.',
    ]))
    story.append(sp(4))
    story.append(note('The recommended naming format is: Donor_Programme_Location (e.g. "TA_WetlandRestore_Odisha").'))
    story.append(sp(10))

    story.append(h2('10.3  Tab Access Control'))
    story.append(body(
        'Control which tabs each role can see in the sidebar. '
        'You can also override access for specific users.'
    ))
    story.append(make_table(
        ['Tab', 'Default: Employee', 'Default: Manager', 'Default: Admin'],
        [
            ['Overview',    '✅', '✅', '✅'],
            ['Reports',     '✅', '✅', '✅'],
            ['Media',       '✅', '✅', '✅'],
            ['Impact',      '❌', '✅', '✅'],
            ['ToC Analysis','❌', '✅', '✅'],
            ['Analytics',   '✅', '✅', '✅'],
            ['Notebook',    '❌', '✅', '✅'],
            ['WhatsApp',    '❌', '❌', '✅'],
            ['Settings',    '❌', '❌', '✅'],
        ],
        col_widths=[4.5*cm, 4*cm, 4*cm, 3.5*cm]
    ))
    story.append(sp(6))
    story.append(body(
        'To override for a specific user: enter their phone number in the "User Override" field, '
        'adjust the toggle switches, and click Save.'
    ))
    story.append(sp(10))

    story.append(h2('10.4  Content Hub Permissions'))
    story.append(body(
        'Control which roles can access each AI content generation feature.'
    ))
    story.append(make_table(
        ['Content Feature', 'Default: Employee', 'Default: Manager', 'Default: Admin'],
        [
            ['Self Report',         '✅', '✅', '✅'],
            ['Team Report',         '❌', '✅', '✅'],
            ['Project Report',      '❌', '✅', '✅'],
            ['Org / Board Report',  '❌', '❌', '✅'],
            ['Impact Report',       '✅', '✅', '✅'],
            ['Story',               '❌', '✅', '✅'],
            ['Social Post',         '✅', '✅', '✅'],
            ['Video / Audio Script','❌', '✅', '✅'],
        ],
        col_widths=[5*cm, 3.5*cm, 3.5*cm, 3.5*cm]
    ))
    story.append(sp(10))

    story.append(h2('10.5  AI Prompts'))
    story.append(body(
        'Customise the instructions that govern how the AI generates content for your organisation. '
        'Changes here affect all users in your organisation.'
    ))
    story.append(make_table(
        ['Prompt', 'Purpose'],
        [
            ['System Prompt',   'Global instruction block prepended to every AI request — defines your organisation\'s voice, rules, and data accuracy constraints'],
            ['Report Templates','Type-specific instructions for each report format (Self, Team, Impact, etc.)'],
            ['Story Template',  'Framework and structure for human-interest story generation'],
        ],
        col_widths=[4*cm, 12*cm]
    ))
    story.append(sp(6))
    story.append(note('Changes to AI prompts are versioned. Click "Roll Back" next to any version to restore a previous prompt.'))
    story.append(sp(10))

    story.append(h2('10.6  AI Intelligence Panel'))
    story.append(body(
        'The AI Intelligence panel (Admin only) gives visibility into AI performance, cost, and quality control.'
    ))
    story.append(make_table(
        ['Section', 'Description'],
        [
            ['Provider Health',      'Live status of Gemini AI — response time and error rate over the last 24 hours'],
            ['7-Day Cost Breakdown', 'Total API requests, estimated cost in USD, and provider split by day'],
            ['Learning Candidates',  'Field data patterns the AI suggests adding as org-level memories — Approve or Reject each one'],
            ['Rules',                'Versioned configuration rules that govern AI behaviour — click Rollback to revert to any previous version'],
        ],
        col_widths=[4.5*cm, 11.5*cm]
    ))
    story.append(PageBreak())

    # ── 11. Role Reference ────────────────────────────────────────────────────
    story += [h1('11. Role & Permission Reference'), section_rule()]
    story.append(body(
        'This section summarises what each role can and cannot do across the platform.'
    ))
    story.append(sp(6))

    story.append(make_table(
        ['Feature / Action', 'Employee', 'Manager', 'Admin'],
        [
            ['View Overview dashboard',               '✅', '✅', '✅'],
            ['View own field reports',                '✅', '✅', '✅'],
            ['View all team reports',                 '❌', '✅', '✅'],
            ['Generate Self Report',                  '✅', '✅', '✅'],
            ['Generate Team / Project Report',        '❌', '✅', '✅'],
            ['Generate Org / Board Report',           '❌', '❌', '✅'],
            ['Generate Social Post',                  '✅', '✅', '✅'],
            ['Access AI Notebook',                    '❌', '✅', '✅'],
            ['View Impact / ToC tabs',                '❌', '✅', '✅'],
            ['Manage WhatsApp flows',                 '❌', '❌', '✅'],
            ['View WhatsApp conversations',           '❌', '❌', '✅'],
            ['Send WhatsApp broadcasts',              '❌', '❌', '✅'],
            ['Add / edit users',                      '❌', '❌', '✅'],
            ['Manage projects',                       '❌', '❌', '✅'],
            ['Configure tab / content permissions',   '❌', '❌', '✅'],
            ['Edit AI prompts',                       '❌', '❌', '✅'],
            ['View AI cost & intelligence panel',     '❌', '❌', '✅'],
            ['View billing',                          '❌', '❌', '✅ (Superadmin)'],
        ],
        col_widths=[8*cm, 2.5*cm, 2.5*cm, 2.5*cm]
    ))
    story.append(PageBreak())

    # ── 12. Troubleshooting ───────────────────────────────────────────────────
    story += [h1('12. Troubleshooting & FAQs'), section_rule()]

    faq = [
        ('I see "Not configured — go to Settings" on the WhatsApp tab.',
         'Your WhatsApp credentials have not been entered yet. Go to WhatsApp → Settings and enter your Phone Number ID, WABA ID, and Access Token. See Section 9.9 for details.'),
        ('My field reports are not appearing on the dashboard.',
         'Check that the date range filter includes today. Also verify that the phone number used to submit matches a registered user. Reports sync within 60 seconds of submission.'),
        ('The AI is taking a long time to generate a report.',
         'Large date ranges with many reports take longer. Try narrowing the date range or applying a project filter to reduce the data volume. Typical generation time is 15–30 seconds.'),
        ('A WhatsApp flow is not triggering when I send the keyword.',
         'Check that the flow is set to ACTIVE (green badge). Verify the keyword is in the trigger list with exact spelling (case-insensitive). Ensure your phone number\'s WhatsApp subscription is active in Meta Business Manager.'),
        ('I cannot see a tab that another team member can see.',
         'Tab visibility is role-based. Ask your Admin to grant access in Settings → Tab Access.'),
        ('The Broadcast tab shows a "not configured" error.',
         'WhatsApp must be fully configured (credentials + webhook) before broadcasts can be sent.'),
        ('I accidentally deleted a flow.',
         'Deleted flows cannot be recovered. Recreate it from a template or from scratch. Consider downloading flow configurations as backups before deleting.'),
        ('How do I add a new field worker?',
         'Go to Settings → User Management → Add User. Enter their name, phone, and role. They can log in immediately after being added.'),
        ('A contact\'s bot session is stuck — they are not receiving messages.',
         'Go to Conversations, find the contact, and click "Stop Bot" to end their session. They can then start a new flow by sending a trigger keyword.'),
        ('The generated report has wrong names or incorrect details.',
         'The AI uses the data in the field reports exactly as submitted. If names or projects are wrong, the underlying field entries need correction. Ask your Admin to update the AI Prompt rules to enforce stricter data accuracy.'),
    ]

    for q, a in faq:
        story.append(KeepTogether([
            Paragraph(f'<b>Q: {q}</b>',
                ParagraphStyle('faq_q', fontName='Helvetica-Bold', fontSize=10,
                    textColor=DARK_PURPLE, spaceBefore=10, spaceAfter=3)),
            Paragraph(f'A: {a}',
                ParagraphStyle('faq_a', fontName='Helvetica', fontSize=10, leading=15,
                    textColor=DARK_GRAY, leftIndent=12, spaceAfter=4)),
            HRFlowable(width='100%', thickness=0.3, color=colors.HexColor('#E5E7EB'), spaceBefore=4, spaceAfter=0),
        ]))
    story.append(PageBreak())

    # ── 13. Appendix ──────────────────────────────────────────────────────────
    story += [h1('Appendix A — Keyboard Shortcuts'), section_rule()]
    story.append(make_table(
        ['Shortcut', 'Action', 'Where It Works'],
        [
            ['Enter',             'Send message',                  'Conversations compose box'],
            ['Shift + Enter',     'New line in message',           'Conversations compose box'],
            ['Delete',            'Remove selected node or edge',  'Flow Builder canvas'],
            ['Scroll wheel',      'Zoom in / out on canvas',       'Flow Builder canvas'],
            ['Click + Drag (canvas)', 'Pan around the canvas',     'Flow Builder canvas'],
        ],
        col_widths=[4.5*cm, 5*cm, 6.5*cm]
    ))
    story.append(sp(16))

    story += [h1('Appendix B — Variable Placeholder Reference'), section_rule()]
    story.append(make_table(
        ['Placeholder', 'Source', 'Example Value'],
        [
            ['{{contact.name}}',    'WhatsApp profile name',         'Ramesh Kumar'],
            ['{{contact.wa_id}}',   'Phone number (no + prefix)',     '919876543210'],
            ['{{user_name}}',       'Wait for Input → save_as',      'Priya'],
            ['{{village}}',         'Wait for Input → save_as',      'Khairatpur'],
            ['{{beneficiaries}}',   'Wait for Input → save_as',      '24'],
            ['{{activity_type}}',   'List or Button → save_as',      'training'],
            ['{{webhook_status}}',  'Webhook response JSON key',      'success'],
        ],
        col_widths=[5*cm, 5*cm, 6*cm]
    ))
    story.append(sp(16))

    story += [h1('Appendix C — Glossary'), section_rule()]
    glossary = [
        ('API', 'Application Programming Interface — a way for two software systems to communicate.'),
        ('WABA', 'WhatsApp Business Account — your registered Meta/WhatsApp business entity.'),
        ('Flow', 'An automated chatbot conversation tree in FieldFlow\'s WhatsApp Platform.'),
        ('Node', 'A single step in a WhatsApp flow (e.g. Send Message, Wait for Input).'),
        ('Session', 'An active conversation between a contact and a WhatsApp flow.'),
        ('Opt-in', 'A contact\'s explicit consent to receive automated WhatsApp messages from you.'),
        ('Webhook', 'An HTTP callback — FieldFlow can call your backend URL when a flow collects data.'),
        ('JSONB', 'A PostgreSQL data type for storing structured JSON data efficiently.'),
        ('ToC', 'Theory of Change — a framework linking activities to outcomes and impact.'),
        ('Gemini', 'Google\'s AI language model used by FieldFlow for report and content generation.'),
        ('Firebase', 'Google\'s authentication service used for user login in FieldFlow.'),
        ('Neon', 'The cloud PostgreSQL database provider used to store all FieldFlow platform data.'),
    ]
    for term, defn in glossary:
        story.append(KeepTogether([
            Paragraph(f'<b>{term}</b>',
                ParagraphStyle('gl_t', fontName='Helvetica-Bold', fontSize=10,
                    textColor=PURPLE, spaceBefore=6, spaceAfter=1)),
            Paragraph(defn,
                ParagraphStyle('gl_d', fontName='Helvetica', fontSize=9.5, leading=14,
                    textColor=DARK_GRAY, leftIndent=12, spaceAfter=2)),
        ]))

    return story


# ── Document assembly ──────────────────────────────────────────────────────────
def build_pdf():
    doc = SimpleDocTemplate(
        OUT_PATH,
        pagesize=A4,
        leftMargin=2*cm, rightMargin=2*cm,
        topMargin=2.8*cm, bottomMargin=2*cm,
        title='FieldFlow Platform — Complete User Manual',
        author='TATWA Technologies',
        subject='User documentation for the FieldFlow field-operations platform',
    )

    # Cover page (custom canvas, no flowables)
    class CoverCanvas(canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            num_pages = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                if self.getPageNumber() == 1:
                    cover_page(self, None)
                else:
                    PT.on_page(self, None)
                super().showPage()
            super().save()

    story = build_story()
    doc.build(story, canvasmaker=CoverCanvas)
    print(f'\n[OK]  PDF written to: {OUT_PATH}')
    print(f'      Size: {os.path.getsize(OUT_PATH) / 1024:.0f} KB')


if __name__ == '__main__':
    build_pdf()
