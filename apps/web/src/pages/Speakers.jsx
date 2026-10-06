import { useEffect, useState } from "react";
import { api } from "@/api/client";
import EnrollmentRecorder from "@/components/EnrollmentRecorder";
import { Trash2, Loader2, Users, X, Volume2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Speakers() {
  const [speakers, setSpeakers] = useState(null);
  const [enrolling, setEnrolling] = useState(false);
  const [name, setName] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [file, setFile] = useState(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [playingId, setPlayingId] = useState(null);

  const load = async () => {
    try {
      setSpeakers(await api.speakers.list());
    } catch (e) {
      setSpeakers([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const enroll = async () => {
    setError("");
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    if (!file) {
      setError("Record a voice clip first.");
      return;
    }
    setEnrolling(true);
    try {
      await api.speakers.enrol(name.trim(), file);
      setName("");
      setAudioUrl("");
      setFile(null);
      setShowEnroll(false);
      await load();
    } catch (e) {
      setError(
        e?.message || "Enrollment failed. Check your API keys and credits."
      );
    } finally {
      setEnrolling(false);
    }
  };

  const remove = async (id) => {
    await api.speakers.remove(id);
    setDeleteTarget(null);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Speakers</h1>
        <Button
          onClick={() => setShowEnroll((s) => !s)}
          variant="outline"
          className="rounded-full"
        >
          {showEnroll ? (
            <>
              <X className="w-4 h-4 mr-1" /> Cancel
            </>
          ) : (
            <>
              <Users className="w-4 h-4 mr-1" /> Add
            </>
          )}
        </Button>
      </div>

      {showEnroll && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            Record about a minute of one person speaking alone — read the line shown aloud, in a
            quiet place with no overlapping voices.
          </p>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Speaker name"
          />
          {audioUrl ? (
            <div className="rounded-xl bg-secondary p-3 space-y-3">
              <audio src={audioUrl} controls className="w-full" />
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Clip ready ✓</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAudioUrl("");
                    setFile(null);
                  }}
                >
                  Redo
                </Button>
              </div>
            </div>
          ) : (
            <EnrollmentRecorder
              onComplete={(f) => {
                setFile(f);
                setAudioUrl(URL.createObjectURL(f));
              }}
            />
          )}
          {enrolling ? (
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-6 space-y-3 animate-in fade-in duration-300">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
                <span className="font-medium">Creating voiceprint…</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Analyzing the voice sample and creating a voiceprint. This takes about 10-20 seconds.
              </p>
            </div>
          ) : (
            <>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={enroll} className="w-full rounded-full">
                Enroll speaker
              </Button>
            </>
          )}
        </div>
      )}

      {!speakers ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : speakers.length === 0 ? (
        <p className="text-center py-20 text-muted-foreground text-sm">
          No speakers enrolled yet.
          {!showEnroll && (
            <span className="block mt-2">Tap “Add” to enroll one.</span>
          )}
        </p>
      ) : (
        <div className="space-y-2">
          {speakers.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-xl border border-border bg-card p-3"
            >
              <div>
                <p className="font-medium">{s.name}</p>
                {s.hasVoiceprint ? (
                  <p className="text-xs text-muted-foreground">Voiceprint enrolled</p>
                ) : (
                  <p className="text-xs text-amber-600">
                    No voiceprint — enroll a clip for auto-recognition
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                {s.enrollmentAudioUrl && (
                  <Button size="icon" variant="ghost" onClick={() => setPlayingId(playingId === s.id ? null : s.id)}>
                    <Volume2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(s)}>
                  <Trash2 className="w-4 h-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))}
          {playingId && (() => {
            const sp = speakers.find((s) => s.id === playingId);
            if (!sp?.enrollmentAudioUrl) return null;
            return (
              <div className="rounded-xl border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground mb-2">Enrollment sample for {sp.name}</p>
                <audio src={sp.enrollmentAudioUrl} controls autoPlay className="w-full" />
              </div>
            );
          })()}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the voiceprint. Phase 2 will use voiceprints to name speakers automatically. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && remove(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}