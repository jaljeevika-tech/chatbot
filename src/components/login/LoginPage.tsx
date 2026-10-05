import { useState } from 'react';
import { AlertCircle, Loader2, Phone, Lock } from 'lucide-react';
import { useAuthContext } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';

export function LoginPage() {
  const { login } = useAuthContext();
  const { org }   = useOrg();
  const [phone,    setPhone]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);
  // Forgot-password panel: emails a reset link if the account has an email on file.
  const [forgot,   setForgot]   = useState(false);
  const [notice,   setNotice]   = useState('');
  const orgSlug = new URLSearchParams(window.location.search).get('org');

  const orgName = org?.branding?.org_name ?? 'FieldFlow';
  const sidebar = org?.branding?.theme?.sidebar ?? '#341272';

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!phone || !password) { setError('Enter your phone number and password.'); return; }
    const digits = phone.replace(/\D/g, '');
    const normalised = digits.length === 10 ? `91${digits}` : digits;
    setBusy(true);
    try {
      await login(normalised, password);
    } catch (e: any) {
      setError(e.message ?? 'Login failed. Check your credentials.');
    } finally {
      setBusy(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setNotice('');
    if (!orgSlug) { setError("Use your organisation's login link (it includes ?org=…) to reset your password."); return; }
    if (!phone) { setError('Enter your phone number.'); return; }
    const digits = phone.replace(/D/g, '');
    setBusy(true);
    try {
      const r = await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgSlug, phone: digits.length === 10 ? `91${digits}` : digits }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'Something went wrong. Try again.');
      setNotice(body.message || 'If this number has an account with an email address, a reset link has been sent to it.');
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4 font-sans"
      style={{ background: `linear-gradient(135deg, ${sidebar} 0%, #1D0752 100%)` }}
    >
      <div className="w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl p-10">
        <div className="text-center mb-10">
          <div className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6 overflow-hidden">
            {org?.branding?.logo_url
              ? <img src={org.branding.logo_url} alt={orgName} className="w-20 h-20 object-contain" />
              : <img src="/logo.png" alt="Logo" className="w-20 h-20 object-contain" />
            }
          </div>
          <h1 className="text-4xl font-black text-gray-900 tracking-tighter">{orgName}</h1>
          <p className="text-sm text-gray-400 mt-2 font-bold uppercase tracking-[0.2em]">Management Access</p>
        </div>

        <form onSubmit={forgot ? handleForgot : handleLogin} className="space-y-5">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">Phone Number</label>
            <div className="relative group">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 group-focus-within:text-[#A78BFA] transition-colors">
                <Phone className="w-5 h-5" />
              </div>
              <input
                type="tel"
                placeholder="9876543210"
                value={phone}
                onChange={e => setPhone(e.target.value.replace(/[^\d+]/g, ''))}
                autoComplete="tel"
                className="w-full bg-gray-50 border-2 border-gray-100 rounded-2xl py-4 pl-12 pr-4 text-gray-800 font-bold placeholder:text-gray-200 focus:border-[#A78BFA] focus:bg-white transition-all outline-none"
              />
            </div>
          </div>

          {!forgot && <div className="space-y-2">
            <div className="flex items-center justify-between ml-1">
              <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Password</label>
              <button type="button" onClick={() => { setForgot(true); setError(''); setNotice(''); }} className="text-[11px] font-bold text-[#7c3aed] hover:underline">Forgot password?</button>
            </div>
            <div className="relative group">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 group-focus-within:text-[#A78BFA] transition-colors">
                <Lock className="w-5 h-5" />
              </div>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full bg-gray-50 border-2 border-gray-100 rounded-2xl py-4 pl-12 pr-4 text-gray-800 font-bold placeholder:text-gray-200 focus:border-[#A78BFA] focus:bg-white transition-all outline-none"
              />
            </div>
          </div>}

          {forgot && (
            <p className="text-xs text-gray-500 leading-relaxed">Enter your phone number. If your account has an email address, we'll send a link to choose a new password. Otherwise, ask your administrator.</p>
          )}

          <button
            type="submit"
            disabled={busy || !phone || (!forgot && !password)}
            className="w-full text-white font-black py-4 rounded-2xl shadow-xl transition-all hover:-translate-y-0.5 active:translate-y-0 flex items-center justify-center gap-3 disabled:opacity-40"
            style={{ background: sidebar }}
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : forgot ? 'Send reset link' : 'Sign In'}
          </button>
          {forgot && (
            <button type="button" onClick={() => { setForgot(false); setError(''); setNotice(''); }} className="w-full text-xs font-bold text-gray-500 hover:text-gray-800">Back to sign in</button>
          )}
        </form>

        {notice && (
          <div className="mt-6 text-green-700 text-[11px] bg-green-50 rounded-2xl p-4 border border-green-100 font-bold leading-tight">{notice}</div>
        )}

        {error && (
          <div className="mt-6 flex items-start gap-3 text-red-600 text-[11px] bg-red-50 rounded-2xl p-4 border border-red-100">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="font-bold leading-tight">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}
