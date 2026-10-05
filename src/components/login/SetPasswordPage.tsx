// /set-password?token=… — opened from an invite or password-reset email.
// Public (no login): the single-use token is the credential. See
// lib/authTokens.js and POST /api/auth/set-password.

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Lock } from 'lucide-react';

type Info = { valid: boolean; purpose?: 'invite' | 'reset'; name?: string; org_name?: string; org_slug?: string };
const MIN = 10;

export function SetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [info, setInfo] = useState<Info | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [doneSlug, setDoneSlug] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/auth/token-info?token=${encodeURIComponent(token)}`)
      .then(r => r.json()).then(setInfo).catch(() => setInfo({ valid: false }));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (pw.length < MIN) { setError(`Use at least ${MIN} characters.`); return; }
    if (pw !== pw2) { setError('The two passwords don’t match.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/set-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: pw }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'Could not set the password.');
      // Drop the token from the address bar / history once it's spent.
      window.history.replaceState(null, '', '/set-password');
      setDoneSlug(body.org_slug ?? info?.org_slug ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password.');
    } finally {
      setBusy(false);
    }
  }

  const loginHref = doneSlug ? `/?org=${encodeURIComponent(doneSlug)}` : '/';

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 font-sans" style={{ background: 'linear-gradient(135deg, #341272 0%, #1D0752 100%)' }}>
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8">
        {!info ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
        ) : doneSlug !== null ? (
          <div className="text-center">
            <CheckCircle2 className="w-12 h-12 text-green-600 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-900">Password set</h1>
            <p className="text-sm text-gray-500 mt-2">You can now sign in with your phone number and new password.</p>
            <a href={loginHref} className="mt-6 inline-flex w-full justify-center rounded-2xl bg-[#341272] text-white font-bold py-3.5">Go to sign in</a>
          </div>
        ) : !info.valid ? (
          <div className="text-center">
            <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-gray-900">This link has expired</h1>
            <p className="text-sm text-gray-500 mt-2">Links work once and expire after a short time. Ask your administrator for a new one, or use “Forgot password” on your organisation’s sign-in page.</p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4"><Lock className="w-6 h-6 text-[#341272]" /></div>
              <h1 className="text-xl font-bold text-gray-900">{info.purpose === 'invite' ? `Welcome, ${info.name}` : 'Choose a new password'}</h1>
              <p className="text-sm text-gray-500 mt-1">{info.purpose === 'invite' ? `Set a password for your ${info.org_name} account.` : `For your ${info.org_name} account.`}</p>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <label className="block">
                <span className="text-xs font-semibold text-gray-500">New password</span>
                <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} autoFocus
                  className="mt-1 w-full rounded-xl border-2 border-gray-100 bg-gray-50 px-4 py-3 outline-none focus:border-[#A78BFA] focus:bg-white" />
                <span className="text-[11px] text-gray-400">At least {MIN} characters.</span>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-gray-500">Confirm password</span>
                <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)}
                  className="mt-1 w-full rounded-xl border-2 border-gray-100 bg-gray-50 px-4 py-3 outline-none focus:border-[#A78BFA] focus:bg-white" />
              </label>
              {error && <div className="flex items-start gap-2 rounded-xl bg-red-50 border border-red-100 text-red-600 text-xs p-3"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
              <button type="submit" disabled={busy || !pw || !pw2}
                className="w-full rounded-2xl bg-[#341272] text-white font-bold py-3.5 disabled:opacity-40 flex items-center justify-center">
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Set password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
