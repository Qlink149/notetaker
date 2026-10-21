import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Check, ChevronDown, ChevronUp, X, Plus } from 'lucide-react';
import { api } from '@/api/client';
import AudioRecorder from '@/components/AudioRecorder';
import AudioUpload from '@/components/AudioUpload';
import GroupRecording from '@/components/GroupRecording';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AUDIO_ACCEPT,
  getUploadSignature,
  uploadToCloudinary,
  validateAudioFile,
} from '@/lib/cloudinaryUpload';
import { clearRecording } from '@/lib/recordingStore';
import { useLeaveWarning } from '@/lib/useLeaveWarning';
import { LANGUAGES } from '@/lib/format';
import { FEATURES } from '@/lib/features';

/** Most files one meeting can be uploaded in (the server checks it too). */
const MAX_PARTS = 5;

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function Record() {
  const [title, setTitle] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  // the meeting's audio: one file, or several files of one meeting in order (Part 1, 2, 3)
  const [files, setFiles] = useState([]);
  const file = files[0] ?? null;
  const [uploadPart, setUploadPart] = useState(0);
  const [languages, setLanguages] = useState(['hi', 'gu', 'en']);
  const [participants, setParticipants] = useState('');
  const [engine, setEngine] = useState('');
  const [defaultEngine, setDefaultEngine] = useState('gemini');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadMb, setUploadMb] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();

  // A recording that is not safely uploaded yet exists only in this page and the phone's saved copy: ask before leaving.
  useLeaveWarning(creating || Boolean(file?.recorded));

  useEffect(() => {
    api.workspace
      .settings()
      .then((s) => {
        setLanguages(s.languages);
        setDefaultEngine(s.engine);
      })
      .catch(() => {});
  }, []);

  // Duration is measured by the server after upload; nothing here depends on the browser's guess.
  const handleAudioReady = (f, info = {}) => {
    const verr = validateAudioFile(f);
    if (verr) {
      setError(verr);
      return;
    }
    setError('');
    setNotice(
      info.stoppedEarly
        ? `The recording stopped by itself at ${fmtClock(info.seconds)}: the microphone was probably taken by a call or another app. What was captured is below; record the rest as a new meeting if you need it.`
        : '',
    );
    setFiles([f]);
    setAudioUrl(URL.createObjectURL(f));
  };

  // Files picked together are parts of one meeting: new ones go after the parts already listed, oldest first
  // (the order they were recorded); the order can be changed before upload.
  const handleFiles = (picked, base = []) => {
    const bad = picked.map(validateAudioFile).find(Boolean);
    if (bad) {
      setError(bad);
      return;
    }
    const sorted = [...picked].sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0));
    const next = [...base, ...sorted].filter(
      (f, i, all) => all.findIndex((g) => g.name === f.name && g.size === f.size) === i,
    );
    if (next.length > MAX_PARTS) {
      setError(`At most ${MAX_PARTS} files per meeting.`);
      return;
    }
    setError('');
    setNotice('');
    if (next.length === 1) return handleAudioReady(next[0]);
    setAudioUrl('');
    setFiles(next);
  };
  const movePart = (i, by) =>
    setFiles((prev) => {
      const next = [...prev];
      const j = i + by;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removePart = (i) =>
    setFiles((prev) => {
      const next = prev.filter((_, k) => k !== i);
      if (next.length === 1) setAudioUrl(URL.createObjectURL(next[0]));
      return next;
    });

  const toggleLanguage = (code) =>
    setLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code],
    );

  const handleCreate = async () => {
    setError('');
    if (!file) return setError('Record or upload audio first.');
    if (!languages.length) return setError('Pick at least one language.');
    setCreating(true);
    try {
      // every file goes into the same meeting folder; the meeting is created only once all are uploaded
      const sig = await getUploadSignature();
      setUploading(true);
      const uploaded = [];
      for (const [i, f] of files.entries()) {
        setUploadPart(i + 1);
        setUploadPct(0);
        const s = i === 0 ? sig : await getUploadSignature(sig.meetingId);
        const u = await uploadToCloudinary(f, s, (pct, loaded) => {
          setUploadPct(pct);
          setUploadMb(loaded / (1024 * 1024));
        });
        uploaded.push({ publicId: u.publicId, url: u.url, fileName: f.name });
      }
      setUploading(false);
      const count = parseInt(participants, 10);
      const meeting = await api.meetings.create({
        meetingId: sig.meetingId,
        title: title.trim() || `Meeting ${new Date().toLocaleDateString()}`,
        publicId: uploaded[0].publicId,
        url: uploaded[0].url,
        ...(uploaded.length > 1 ? { parts: uploaded } : {}),
        languages,
        expectedParticipants: Number.isFinite(count) && count > 0 ? count : null,
        ...(engine ? { engine } : {}),
      });
      // the server has the meeting: only now is the phone's saved copy of a recording no longer needed
      if (file.recorded) await clearRecording().catch(() => {});
      navigate(`/meetings/${meeting.id}`);
    } catch (e) {
      setError(e?.message || 'Could not create meeting. Try again.');
      setUploading(false);
      setCreating(false);
    }
  };

  return (
    <div>
      <h1 className="k-serif text-[40px] leading-tight mb-6">New meeting</h1>
      <div className="space-y-5">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Title (optional)</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weekly sync"
          />
        </div>

        <div>
          <label className="text-sm font-medium mb-2 block">Languages spoken</label>
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => toggleLanguage(l.code)}
                aria-pressed={languages.includes(l.code)}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                  languages.includes(l.code)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                {languages.includes(l.code) && <Check className="w-3 h-3 inline mr-1" />}
                {l.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Names and company terms come from the glossary in Settings.
          </p>
        </div>

        <div>
          <label className="text-sm font-medium mb-1.5 block">
            How many people speak? (recommended)
          </label>
          <Input
            type="number"
            min={1}
            max={50}
            inputMode="numeric"
            value={participants}
            onChange={(e) => setParticipants(e.target.value)}
            placeholder="e.g. 4"
            className="max-w-[8rem]"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Helps tell similar voices apart. A rough number is fine.
          </p>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="text-sm text-muted-foreground inline-flex items-center gap-1"
            aria-expanded={showAdvanced}
          >
            <ChevronDown
              className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
            />
            Advanced
          </button>
          {showAdvanced && (
            <div className="mt-2 rounded-xl border border-border p-3">
              <label className="text-sm font-medium mb-1.5 block" htmlFor="engine">
                Transcription engine
              </label>
              <select
                id="engine"
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Workspace default ({defaultEngine})</option>
                <option value="gemini">Gemini</option>
                <option value="deepgram">Deepgram</option>
              </select>
            </div>
          )}
        </div>

        {FEATURES.liveRecording && <GroupRecording />}

        <div>
          <label className="text-sm font-medium mb-2 block">Audio</label>
          {audioUrl ? (
            <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
              {notice && (
                <p
                  role="alert"
                  className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-2.5"
                >
                  {notice}
                </p>
              )}
              <audio src={audioUrl} controls className="w-full" />
              <p className="text-xs text-muted-foreground">
                {file?.name} · {(file?.size / (1024 * 1024)).toFixed(1)} MB — duration is measured
                after upload.
              </p>
              {!FEATURES.liveRecording && files.length === 1 && !file?.recorded && (
                <label className="block text-center" data-testid="add-part">
                  <input
                    type="file"
                    accept={AUDIO_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const more = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (more.length) handleFiles(more, [file]);
                    }}
                  />
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground underline cursor-pointer">
                    <Plus className="w-4 h-4" /> Add the next part of this meeting
                  </span>
                </label>
              )}
              <Button
                variant="outline"
                className="w-full rounded-full"
                onClick={() => {
                  setAudioUrl('');
                  setFiles([]);
                }}
              >
                Use different audio
              </Button>
            </div>
          ) : files.length > 1 ? (
            <div
              className="rounded-2xl border border-border bg-card p-4 space-y-3"
              data-testid="parts"
            >
              <p className="text-sm">
                One meeting in {files.length} files. They are joined in this order into one
                recording, with one transcript and one summary.
              </p>
              <ol className="space-y-2">
                {files.map((f, i) => (
                  <li
                    key={`${f.name}-${f.size}`}
                    className="flex items-center gap-2 rounded-xl border border-border px-3 py-2"
                  >
                    <span className="text-xs font-semibold text-muted-foreground w-14 shrink-0">
                      Part {i + 1}
                    </span>
                    <span className="text-sm flex-1 min-w-0 truncate">{f.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {(f.size / (1024 * 1024)).toFixed(1)} MB
                    </span>
                    <button
                      type="button"
                      aria-label={`Move part ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => movePart(i, -1)}
                      className="p-1 disabled:opacity-30"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move part ${i + 1} down`}
                      disabled={i === files.length - 1}
                      onClick={() => movePart(i, 1)}
                      className="p-1 disabled:opacity-30"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove part ${i + 1}`}
                      onClick={() => removePart(i)}
                      className="p-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ol>
              {files.length < MAX_PARTS && (
                <label className="block text-center">
                  <input
                    type="file"
                    accept={AUDIO_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const more = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (more.length) handleFiles(more, files);
                    }}
                  />
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground underline cursor-pointer">
                    <Plus className="w-4 h-4" /> Add another part
                  </span>
                </label>
              )}
              <Button
                variant="outline"
                className="w-full rounded-full"
                onClick={() => setFiles([])}
              >
                Use different audio
              </Button>
            </div>
          ) : FEATURES.liveRecording ? (
            <AudioRecorder onComplete={handleAudioReady} />
          ) : (
            <AudioUpload onComplete={handleAudioReady} onFiles={handleFiles} />
          )}
        </div>

        {creating ? (
          <div className="rounded-2xl border border-border bg-card p-6 space-y-4 animate-in fade-in duration-300">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
              <span className="font-medium">
                {uploading
                  ? files.length > 1
                    ? `Uploading file ${uploadPart} of ${files.length}…`
                    : 'Uploading audio…'
                  : 'Creating your meeting…'}
              </span>
            </div>
            {uploading && (
              <div className="space-y-2">
                <div className="h-2.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${uploadPct}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-right">
                  {uploadPct}% · {uploadMb.toFixed(1)} MB
                </p>
              </div>
            )}
          </div>
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              onClick={handleCreate}
              disabled={!file}
              className="w-full h-12 rounded-full text-base"
            >
              Process meeting
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
