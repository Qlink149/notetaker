import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Folder, Loader2, UploadCloud } from 'lucide-react';
import { api } from '@/api/client';
import { useKeptOptional } from '@/lib/keptStore';
import { Button } from '@/components/ui/button';

const when = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * The meeting's folder (Jolto, Internal…) and "Save to Drive": a Google Doc in MeetingID/<folder> in the
 * connected Drive. Pressing it again updates the same Doc, and moves it when the folder changed.
 */
export default function MeetingDrive({ meeting, hasTranscript, onChange }) {
  const folders = useKeptOptional()?.folders ?? [];
  const [drive, setDrive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.drive.status())
      .then((s) => live && setDrive(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const setFolder = async (value) => {
    setError('');
    try {
      onChange(await api.meetings.setFolder(meeting.id, value || null));
    } catch (e) {
      setError(e?.message || 'Could not change the folder.');
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      onChange(await api.meetings.saveToDrive(meeting.id));
    } catch (e) {
      if (e?.message === 'drive_reconnect') {
        setDrive((d) => ({ ...d, connected: false }));
        setError('Google Drive access was removed. Connect it again in Settings.');
      } else setError(e?.message || 'Could not save to Drive.');
    } finally {
      setBusy(false);
    }
  };

  const saved = meeting.drive;
  // filed somewhere else since it was saved: the next save moves the Doc
  const moved = saved && (saved.folder ?? null) !== (meeting.folder ?? null);

  if (!folders.length && !drive?.available) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5" data-testid="meeting-drive">
      {folders.length > 0 && (
        <label className="inline-flex items-center gap-1.5 h-9 pl-3 pr-1 rounded-full border border-input bg-card text-sm">
          <Folder className="w-4 h-4 text-muted-foreground" />
          <select
            aria-label="Folder"
            value={meeting.folder ?? ''}
            onChange={(e) => setFolder(e.target.value)}
            className="bg-transparent outline-none pr-1 cursor-pointer"
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {meeting.folder && !folders.includes(meeting.folder) && (
              <option value={meeting.folder}>{meeting.folder}</option>
            )}
          </select>
        </label>
      )}
      {drive?.available &&
        (drive.connected ? (
          <Button
            size="sm"
            variant={saved && !moved ? 'outline' : 'default'}
            className="rounded-full h-9"
            disabled={busy || !hasTranscript}
            onClick={save}
            title={hasTranscript ? undefined : 'Available once the transcript is ready'}
          >
            {busy ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <UploadCloud className="w-4 h-4 mr-1.5" />
            )}
            {busy ? 'Saving…' : saved ? 'Save to Drive again' : 'Save to Drive'}
          </Button>
        ) : (
          <Link to="/settings" className="text-sm text-muted-foreground underline">
            Connect Google Drive to save meetings there
          </Link>
        ))}
      {saved && (
        <a
          href={saved.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Saved {when(saved.savedAt)}
          {saved.folder ? ` in ${saved.folder}` : ''} · Open in Drive
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
      {moved && (
        <span className="text-xs text-amber-700">Folder changed: save again to move it.</span>
      )}
      {error && <span className="text-xs text-destructive w-full">{error}</span>}
    </div>
  );
}
