// Shown when the URL's ?org=<slug> differs from the signed-in org: the session decides
// the tenant and ?org= is only read at login, so the link would otherwise open the wrong org.

import { useState } from 'react';
import { ArrowLeftRight, Loader2 } from 'lucide-react';

export function OrgSwitchPrompt({ currentOrgName, linkSlug, onStay, onSwitch }: {
  currentOrgName: string;
  linkSlug: string;
  onStay: () => void;
  onSwitch: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="min-h-screen flex items-center justify-center px-4 font-sans" style={{ background: 'linear-gradient(135deg, #341272 0%, #1D0752 100%)' }}>
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8 text-center">
        <div className="w-12 h-12 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
          <ArrowLeftRight className="w-6 h-6 text-[#341272]" />
        </div>
        <h1 className="text-xl font-bold text-gray-900">Switch organisation?</h1>
        <p className="text-sm text-gray-500 mt-2">
          This link is for <strong className="text-gray-800">{linkSlug}</strong>, but you're signed in to{' '}
          <strong className="text-gray-800">{currentOrgName}</strong>.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={async () => { setBusy(true); await onSwitch(); }}
            disabled={busy}
            className="w-full rounded-2xl bg-[#341272] text-white font-bold py-3.5 disabled:opacity-60 flex items-center justify-center"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : `Sign out and sign in to ${linkSlug}`}
          </button>
          <button onClick={onStay} disabled={busy} className="w-full rounded-2xl border-2 border-gray-100 text-gray-700 font-bold py-3 hover:bg-gray-50">
            Stay in {currentOrgName}
          </button>
        </div>
      </div>
    </div>
  );
}
