// Public privacy notice at `/privacy` (no login). Mirrors docs/PrivacyNotice.md, but
// policy points still awaiting a board decision are worded as "being finalized" rather
// than showing draft placeholders; update both when they land. Generic FieldFlow
// branding, since org metadata needs auth.

import { ArrowLeft } from 'lucide-react'
import { FF } from '../theme/colors'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: "'Newsreader',serif", fontSize: 19, fontWeight: 600, color: FF.tealText, marginBottom: 8 }}>
        {title}
      </h2>
      <div style={{ fontSize: 14, lineHeight: 1.7, color: '#33474A' }}>{children}</div>
    </section>
  )
}

function Pending({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ background: FF.amberBg, color: FF.amber, padding: '1px 6px', borderRadius: 5, fontSize: 13.5 }}>
      {children}
    </span>
  )
}

export function PrivacyPolicyPage() {
  return (
    <div style={{ minHeight: '100vh', background: FF.bg, fontFamily: "'IBM Plex Sans',sans-serif" }}>
      <div style={{ position: 'sticky', top: 0, background: FF.tealDark, zIndex: 1 }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
            <img src="/logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          <div style={{ fontFamily: "'Newsreader',serif", fontSize: 17, fontWeight: 600, color: '#fff' }}>
            FieldFlow · Privacy &amp; Data Protection
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <a
              href="/"
              className="flex items-center gap-1.5 rounded-lg text-xs font-semibold"
              style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.12)', color: '#fff', textDecoration: 'none' }}
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </a>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 20px 60px' }}>
        <p style={{ fontSize: 12.5, color: FF.textFaint, marginBottom: 28 }}>Last updated: August 2026</p>

        <Section title="Who we are">
          <p>Jaljeevika ("we", "us", "our") uses FieldFlow to manage and report on our community development programs. This notice explains what personal information we collect about people who participate in or are affected by our programs ("you"), why we collect it, and what rights you have over it.</p>
        </Section>

        <Section title="What we collect">
          <p>Depending on which of our programs you interact with, we may collect:</p>
          <ul style={{ paddingLeft: 20, marginTop: 8, marginBottom: 8 }}>
            <li>Your name, phone number, and location (village, panchayat, block, district, state)</li>
            <li>Demographic information (gender, social category)</li>
            <li>Livelihood information relevant to our programs (income, production figures, business activity, employment)</li>
            <li>Records of trainings, support, or resources you've received through our programs</li>
            <li>Photos or videos taken during program activities, where you have separately consented (see below)</li>
          </ul>
          <p>We do not collect financial account numbers, government ID numbers (Aadhaar, PAN, etc.), or health information as part of standard program registration.</p>
        </Section>

        <Section title="Why we collect it">
          <p>We use this information to register you for and deliver our programs, track our reach and impact, contact you about program activities, and meet our legal and reporting obligations to donors and government bodies.</p>
          <p style={{ marginTop: 8 }}>The exact legal basis for collecting your data (your consent, versus our legitimate interest in delivering a program you've asked to join) is <Pending>currently being finalized with our legal counsel</Pending> and this section will be updated once that's settled.</p>
        </Section>

        <Section title="Photos and videos">
          <p>We ask for your separate consent before using your photo, video, or name in any donor report, newsletter, or public material. If you are under 18, this consent must come from your parent or guardian, not from you directly. You can decline without affecting your ability to participate in our programs, and you can withdraw consent already given at any time by speaking to program staff.</p>
        </Section>

        <Section title="How long we keep your information">
          <p>The exact retention period for beneficiary information after your last program interaction is <Pending>still being finalized by our board</Pending>. Once decided, this section will state that period; after it, your personally identifying details (name, phone number, sub-district location, income figures) are anonymized while aggregate program statistics are retained for our own reporting.</p>
        </Section>

        <Section title="Where your information is stored">
          <p>Your information is stored on cloud servers operated by our technology providers. As of August 2026, our main database is hosted in Singapore, and the systems that collect new registrations run in Mumbai, India.</p>
        </Section>

        <Section title="Keeping your information secure">
          <p>We limit access to your information to staff who need it to do their jobs, and we keep a record of who accesses or changes it. Your phone number, income information, and sub-district location are stored in encrypted form. We do not sell your information to anyone.</p>
        </Section>

        <Section title="Your rights">
          <p>You can ask us to see the information we hold about you, correct information that is wrong or out of date, or delete your information (we will anonymize your record rather than delete program history that also involves other beneficiaries, unless deletion is genuinely possible).</p>
          <p style={{ marginTop: 8 }}>To make any of these requests, please speak to a program staff member in person, by phone, or over WhatsApp — they can log your request directly with our team. A dedicated contact for these requests is <Pending>being appointed by our board</Pending> and will be listed here once named.</p>
        </Section>

        <Section title="Changes to this notice">
          <p>We may update this notice from time to time. The version in effect is always available at this page.</p>
        </Section>
      </div>
    </div>
  )
}
