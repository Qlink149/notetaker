import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  AUDIO_ACCEPT,
  getUploadSignature,
  uploadToCloudinary,
  validateAudioFile,
} from '@/lib/cloudinaryUpload';

/**
 * Add recordings made later to the end of this meeting (client request, 20 Oct). The person picks the files,
 * reads what will happen, and confirms; the files are uploaded into the meeting's folder and the meeting is
 * processed again with them appended.
 */
export default function AddContinuation({ meeting, onAdded }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const pick = (e) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!picked.length) return;
    const bad = picked.map(validateAudioFile).find(Boolean);
    if (bad) return setError(bad);
    setError('');
    setFiles([...picked].sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0)));
  };

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const parts = [];
      for (const [i, f] of files.entries()) {
        setProgress(
          files.length > 1 ? `Uploading file ${i + 1} of ${files.length}…` : 'Uploading…',
        );
        const sig = await getUploadSignature(meeting.id);
        const u = await uploadToCloudinary(f, sig, () => {});
        parts.push({ publicId: u.publicId, url: u.url, fileName: f.name });
      }
      setProgress('Starting…');
      const m = await api.meetings.addParts(meeting.id, parts);
      setFiles([]);
      onAdded?.(m);
    } catch (e) {
      setError(e?.message || 'Could not add the recording. Try again.');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  if (!files.length)
    return (
      <div className="space-y-1">
        <label className="block" data-testid="add-continuation">
          <input type="file" accept={AUDIO_ACCEPT} multiple className="hidden" onChange={pick} />
          <span className="flex items-center justify-center h-10 w-full rounded-md border border-input text-sm cursor-pointer hover:bg-secondary">
            <Plus className="w-4 h-4 mr-2" /> Add a continuation recording
          </span>
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );

  return (
    <div
      className="rounded-xl border border-border p-4 space-y-3"
      data-testid="continuation-confirm"
    >
      <p className="text-sm font-medium">
        Add {files.length === 1 ? 'this recording' : `these ${files.length} recordings`} to the end
        of “{meeting.title}”?
      </p>
      <ol className="text-sm list-decimal pl-5 space-y-0.5">
        {files.map((f) => (
          <li key={`${f.name}-${f.size}`} className="truncate">
            {f.name}
          </li>
        ))}
      </ol>
      <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
        <li>The meeting is processed again with the new audio after the existing audio.</li>
        <li>The transcript of the existing audio is kept; only the new part is transcribed.</li>
        <li>
          Names you gave to speakers are kept. Lines you moved to another speaker by hand are
          redone.
        </li>
        <li>A new summary and action items are written for the whole meeting.</li>
      </ul>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={add} disabled={busy} className="flex-1">
          {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          {busy ? progress : 'Add and process'}
        </Button>
        <Button variant="outline" onClick={() => setFiles([])} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
