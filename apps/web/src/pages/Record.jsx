import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Check, ChevronDown } from 'lucide-react';
import { api } from '@/api/client';
import AudioRecorder from '@/components/AudioRecorder';
import AudioUpload from '@/components/AudioUpload';
import GroupRecording from '@/components/GroupRecording';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getUploadSignature, uploadToCloudinary, validateAudioFile } from '@/lib/cloudinaryUpload';
import { clearRecording } from '@/lib/recordingStore';
import { useLeaveWarning } from '@/lib/useLeaveWarning';
import { LANGUAGES } from '@/lib/format';
import { FEATURES } from '@/lib/features';

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function Record() {
  const [title, setTitle] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [file, setFile] = useState(null);
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
    setFile(f);
    setAudioUrl(URL.createObjectURL(f));
  };

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
      const sig = await getUploadSignature();
      setUploading(true);
      const uploaded = await uploadToCloudinary(file, sig, (pct, loaded) => {
        setUploadPct(pct);
        setUploadMb(loaded / (1024 * 1024));
      });
      setUploading(false);
      const count = parseInt(participants, 10);
      const meeting = await api.meetings.create({
        meetingId: sig.meetingId,
        title: title.trim() || `Meeting ${new Date().toLocaleDateString()}`,
        publicId: uploaded.publicId,
        url: uploaded.url,
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
      <h1 className="text-2xl font-bold tracking-tight mb-6">New meeting</h1>
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
              <Button
                variant="outline"
                className="w-full rounded-full"
                onClick={() => {
                  setAudioUrl('');
                  setFile(null);
                }}
              >
                Use different audio
              </Button>
            </div>
          ) : FEATURES.liveRecording ? (
            <AudioRecorder onComplete={handleAudioReady} />
          ) : (
            <AudioUpload onComplete={handleAudioReady} />
          )}
        </div>

        {creating ? (
          <div className="rounded-2xl border border-border bg-card p-6 space-y-4 animate-in fade-in duration-300">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
              <span className="font-medium">
                {uploading ? 'Uploading audio…' : 'Creating your meeting…'}
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
