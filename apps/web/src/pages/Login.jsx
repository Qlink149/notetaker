import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { SkyArt } from '@/components/kept/bits';
import { phaseNow } from '@/lib/kept';

export default function Login() {
  const { login } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const phase = phaseNow();

  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError('');
    try {
      await login(code.trim());
    } catch (err) {
      setError(
        err?.status === 429
          ? 'Too many attempts. Wait a few minutes.'
          : 'That access code is not valid.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 text-white flex flex-col">
      <SkyArt
        className="k-art absolute inset-0"
        phase={phase === 'afternoon' ? 'evening' : phase}
        fade={false}
        sunY={120}
        seed={2.4}
      />
      <form
        onSubmit={submit}
        className="relative z-10 flex-1 flex flex-col w-full max-w-md mx-auto px-7 pt-10 pb-[calc(30px+env(safe-area-inset-bottom))]"
      >
        <div className="text-xs tracking-[0.18em] uppercase font-semibold opacity-75">
          MeetingID · by Clara.ai
        </div>
        <div className="mt-auto font-[var(--font-display)] italic text-[84px] leading-[0.9] tracking-[-0.03em] k-serif">
          Kept.
        </div>
        <div className="k-serif text-[28px] leading-tight mt-3.5 mb-1.5 opacity-95">
          Every promise,
          <br />
          kept.
        </div>
        <p className="text-[14.5px] opacity-85 leading-normal max-w-[300px]">
          Meetings, tasks and gentle reminders for your whole team.
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Workspace access code"
          aria-label="Access code"
          className="k-inp mt-9 text-[var(--k-ink)]"
        />
        <p className="text-xs opacity-80 mt-2 px-1">Enter your workspace access code.</p>
        {error && <p className="text-sm mt-2 font-medium text-[#ffe1db]">{error}</p>}
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="k-btn mt-3 bg-white/90 text-[var(--k-ink)] shadow-[0_14px_34px_rgba(30,20,70,.25)]"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}Continue
        </button>
      </form>
    </div>
  );
}
