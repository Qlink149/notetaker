import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Gauge, LogOut, Mic2, Settings } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { useKept } from '@/lib/keptStore';
import { FEATURES } from '@/lib/features';
import { Sheet } from '@/components/kept/bits';

/** Who "me" is, Speakers, Settings, sign out. Opened from Today's profile button and the desktop sidebar. */
export default function ProfileSheet({ onClose }) {
  const { people, me, setMe, toast } = useKept();
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const mine = people.find((p) => p.id === me);
  return (
    <Sheet title={mine?.name ?? 'You'} onClose={onClose}>
      <div className="px-[18px] pb-4">
        <div className="k-lbl">This is me</div>
        <select
          className="k-inp"
          aria-label="This is me"
          value={me ?? ''}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            try {
              await setMe(e.target.value || null);
              toast('Saved. “My tasks” now follows this person.');
            } catch (err) {
              toast(err?.message || 'Could not save.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Choose a person from the speaker directory…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-[var(--k-sub)] mt-2 px-1">
          “My tasks” and “Given by” use this person.
        </p>
        <div className="k-list mt-4">
          <Link to="/speakers" className="k-act" onClick={onClose}>
            <span className="k-ic">
              <Mic2 className="w-[18px] h-[18px]" />
            </span>
            Speakers (voice directory)
          </Link>
          {FEATURES.insights && (
            <Link to="/dashboard" className="k-act" onClick={onClose}>
              <span className="k-ic">
                <BarChart3 className="w-[18px] h-[18px]" />
              </span>
              Insights
            </Link>
          )}
          {FEATURES.benchmark && (
            <Link to="/benchmark" className="k-act" onClick={onClose}>
              <span className="k-ic">
                <Gauge className="w-[18px] h-[18px]" />
              </span>
              Benchmark
            </Link>
          )}
          <Link to="/settings" className="k-act" onClick={onClose}>
            <span className="k-ic">
              <Settings className="w-[18px] h-[18px]" />
            </span>
            Settings
          </Link>
          <button type="button" className="k-act k-red" onClick={logout}>
            <span className="k-ic">
              <LogOut className="w-[18px] h-[18px]" />
            </span>
            Sign out
          </button>
        </div>
      </div>
    </Sheet>
  );
}
