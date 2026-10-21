import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, FolderPlus, Loader2, X } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const RETURNED = {
  connected: { ok: true, text: 'Google Drive is connected.' },
  cancelled: { ok: false, text: 'Connecting was cancelled.' },
  'no-permission': {
    ok: false,
    text: 'Drive access was not allowed. Connect again and tick the Drive box.',
  },
  failed: { ok: false, text: 'Could not connect Google Drive. Try again.' },
};

/** Connect the workspace's Google Drive once; "Save to Drive" on a meeting then puts it there. */
export function DriveSettings() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const returned = RETURNED[params.get('drive')];

  useEffect(() => {
    api.drive
      .status()
      .then(setStatus)
      .catch(() => setStatus({ available: false, connected: false, email: null }));
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      window.location.assign(await api.drive.start());
    } catch (e) {
      setBusy(false);
      alert(e?.message || 'Could not start connecting.');
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await api.drive.disconnect();
      setStatus((s) => ({ ...s, connected: false, email: null }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-2xl border border-border bg-card p-4 space-y-3"
      data-testid="drive-settings"
    >
      <div>
        <h2 className="font-semibold">Google Drive</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          “Save to Drive” on a meeting puts it in a <b>MeetingID</b> folder in your Drive, in the
          meeting’s folder (Jolto, Internal…). The app can only see the files it makes there.
        </p>
      </div>
      {returned && (
        <p
          role="status"
          className={`text-sm flex items-center gap-2 ${returned.ok ? 'text-emerald-700' : 'text-destructive'}`}
        >
          {returned.text}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              params.delete('drive');
              setParams(params, { replace: true });
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </p>
      )}
      {!status ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : !status.available ? (
        <p className="text-sm text-muted-foreground">
          Not set up on this server yet (a Google sign-in app is needed).
        </p>
      ) : status.connected ? (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-600" /> Connected
            {status.email ? ` as ${status.email}` : ''}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={busy}
            onClick={disconnect}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <Button size="sm" className="rounded-full" disabled={busy} onClick={connect}>
          {busy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
          Connect Google Drive
        </Button>
      )}
    </section>
  );
}

/** The folders meetings are filed under; also the folders made in Google Drive. */
export function FolderSettings() {
  const { workspace, updateWorkspace } = useAuth();
  const [folders, setFolders] = useState(workspace?.folders ?? []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (next) => {
    setBusy(true);
    setError('');
    try {
      const saved = await api.workspace.setFolders(next);
      setFolders(saved);
      updateWorkspace({ folders: saved });
    } catch (e) {
      setError(e?.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-2xl border border-border bg-card p-4 space-y-3"
      data-testid="folder-settings"
    >
      <div>
        <h2 className="font-semibold">Folders</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Pick one when uploading a meeting, or later on the meeting. Removing a folder here leaves
          its meetings unfiled.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {folders.map((f) => (
          <span key={f} className="k-chip !h-8 !text-[13px] !pr-1.5">
            {f}
            <button
              type="button"
              aria-label={`Remove folder ${f}`}
              disabled={busy}
              onClick={() => save(folders.filter((x) => x !== f))}
              className="p-0.5 rounded-full hover:bg-black/5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}
        {!folders.length && <span className="text-sm text-muted-foreground">No folders.</span>}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n || folders.includes(n)) return;
          setName('');
          save([...folders, n]);
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New folder, e.g. Vendors"
          aria-label="New folder"
          maxLength={60}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !name.trim()}>
          <FolderPlus className="w-4 h-4 mr-1" /> Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
