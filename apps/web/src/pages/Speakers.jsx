import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import EnrollmentRecorder from '@/components/EnrollmentRecorder';
import VoiceSamples from '@/components/VoiceSamples';
import { Trash2, Loader2, Users, X, Volume2, Pencil } from 'lucide-react';
import AssignPicker from '@/components/AssignPicker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Email, or role, so two people with the same name are not one row. The value of the option is the id. */
function personHint(p) {
  if (p.email) return p.email;
  if (p.role) return p.role;
  if (p.leftAt) return 'Left';
  if (p.anonymous) return 'Unassigned voice';
  return 'No email on file';
}

/** What the server says when a change is refused, in words for the person. */
function reasonFor(e, fallback) {
  const m = e?.message ?? '';
  if (m === 'undo_newer_change')
    return 'A newer change to the same person is still open. Undo that one first.';
  if (m === 'undo_expired') return 'That undo has expired.';
  if (m === 'undo_already_used') return 'That change was already undone.';
  if (m === 'undo_not_found') return 'That undo is no longer available.';
  return m || fallback;
}

function optionLabel(p) {
  return `${p.name} · ${personHint(p)}`;
}

export default function Speakers() {
  const [speakers, setSpeakers] = useState(null);
  const [canAssign, setCanAssign] = useState(false);
  const [undos, setUndos] = useState([]);
  const [enrolling, setEnrolling] = useState(false);
  const [name, setName] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [file, setFile] = useState(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [openSamples, setOpenSamples] = useState(null);
  // the person whose pencil is open, and a refusal to show under that person (or under the list when no one)
  const [pickerId, setPickerId] = useState(null);
  const [assignError, setAssignError] = useState('');
  const [assignErrorId, setAssignErrorId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);

  const load = async () => {
    try {
      const page = await api.speakers.page();
      setSpeakers(page.speakers);
      setCanAssign(page.canAssignSpeakers);
      setUndos(page.undos ?? []);
    } catch {
      setSpeakers([]);
      setCanAssign(false);
      setUndos([]);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const enroll = async () => {
    setError('');
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    if (!file) {
      setError('Record a voice clip first.');
      return;
    }
    setEnrolling(true);
    try {
      await api.speakers.enrol(name.trim(), file);
      setName('');
      setAudioUrl('');
      setFile(null);
      setShowEnroll(false);
      await load();
    } catch (e) {
      setError(e?.message || 'Enrollment failed. Check your API keys and credits.');
    } finally {
      setEnrolling(false);
    }
  };

  const remove = async (id) => {
    await api.speakers.remove(id);
    setDeleteTarget(null);
    load();
  };

  const fail = (id, e, fallback) => {
    setAssignError(reasonFor(e, fallback));
    setAssignErrorId(id);
  };
  const clearError = () => {
    setAssignError('');
    setAssignErrorId(null);
  };

  /** Describe the change (nothing is written yet) for a chosen person, or for a new name. */
  const requestAssign = async (speakerId, body) => {
    clearError();
    if (body.name !== undefined && !body.name.trim()) {
      setAssignError('Enter a name.');
      setAssignErrorId(speakerId);
      return;
    }
    setBusy(true);
    try {
      const result = await api.speakers.assign(speakerId, body);
      if (result.matches) {
        setPickerId(null);
        setAsk({ type: 'matches', speakerId, name: body.name.trim(), matches: result.matches });
        return;
      }
      if (result.needsConfirmation) {
        setPickerId(null);
        setAsk({ type: 'preview', speakerId, body, preview: result });
      }
    } catch (e) {
      fail(speakerId, e, 'Could not assign that voice.');
    } finally {
      setBusy(false);
    }
  };

  const confirmAssign = async (speakerId, body) => {
    setBusy(true);
    clearError();
    try {
      await api.speakers.assign(speakerId, { ...body, confirm: true });
      setAsk(null);
      setPickerId(null);
      await load();
    } catch (e) {
      fail(speakerId, e, 'Could not assign that voice.');
      setAsk(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmLeave = async (speaker) => {
    setBusy(true);
    try {
      await api.speakers.leave(speaker.id);
      setAsk(null);
      await load();
    } catch (e) {
      fail(null, e, 'Could not update that person.');
      setAsk(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmBack = async (speaker) => {
    setBusy(true);
    try {
      await api.speakers.comeBack(speaker.id);
      setAsk(null);
      await load();
    } catch (e) {
      fail(null, e, 'Could not update that person.');
      setAsk(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmUndo = async (undo) => {
    setBusy(true);
    try {
      await api.speakers.undo(undo.id);
      setAsk(null);
      await load();
    } catch (e) {
      fail(null, e, 'That undo is no longer available.');
      setAsk(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="k-serif text-[40px] leading-tight">Speakers</h1>
        <Button onClick={() => setShowEnroll((s) => !s)} variant="outline" className="rounded-full">
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

      {canAssign && (
        <p className="text-sm text-muted-foreground mb-4">
          Assign a voice to a person to use that name in every meeting. The summary is not
          rewritten. You can undo a change for a short time afterwards.
        </p>
      )}

      {canAssign && undos.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-3 mb-4 space-y-2">
          {undos.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{u.label}</span>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={busy}
                onClick={() => setAsk({ type: 'undo', undo: u })}
              >
                Undo
              </Button>
            </div>
          ))}
        </div>
      )}

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
                    setAudioUrl('');
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
                Analyzing the voice sample and creating a voiceprint. This takes about 10-20
                seconds.
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
          {!showEnroll && <span className="block mt-2">Tap “Add” to enroll one.</span>}
        </p>
      ) : (
        <div className="space-y-2">
          {speakers.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium flex items-center gap-1.5">
                    <span>{s.name}</span>
                    {s.leftAt && (
                      <span className="text-xs font-normal text-muted-foreground">Left</span>
                    )}
                    {canAssign && (
                      <Popover
                        open={pickerId === s.id}
                        onOpenChange={(open) => {
                          setPickerId(open ? s.id : null);
                          clearError();
                        }}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Assign ${s.name} to a person`}
                            title="Assign this voice to a person"
                            className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-80 p-3">
                          <AssignPicker
                            people={speakers.filter((p) => p.id !== s.id)}
                            name={s.name}
                            busy={busy}
                            error={assignErrorId === s.id ? assignError : ''}
                            onPick={(p) => requestAssign(s.id, { personId: p.id })}
                            onAddNew={(name) => requestAssign(s.id, { name })}
                          />
                        </PopoverContent>
                      </Popover>
                    )}
                  </p>
                  {s.hasVoiceprint ? (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      aria-expanded={openSamples === s.id}
                      onClick={() => setOpenSamples(openSamples === s.id ? null : s.id)}
                    >
                      {openSamples === s.id ? 'Hide' : 'Listen to'} voice
                    </button>
                  ) : (
                    <p className="text-xs text-amber-600">
                      No voiceprint — enroll a clip for auto-recognition
                    </p>
                  )}
                  {(s.email || s.role) && (
                    <p className="text-xs text-muted-foreground">{personHint(s)}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {s.enrollmentAudioUrl && (
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setPlayingId(playingId === s.id ? null : s.id)}
                    >
                      <Volume2 className="w-4 h-4 text-muted-foreground" />
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(s)}>
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
              {openSamples === s.id && (
                <div className="mt-3 pt-3 border-t border-border">
                  <VoiceSamples personId={s.id} name={s.name} onChanged={load} />
                </div>
              )}
              {canAssign && (s.leftAt || !s.anonymous) && (
                <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2">
                  {!s.anonymous && !s.leftAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAsk({ type: 'leave', speaker: s })}
                    >
                      Mark as left
                    </Button>
                  )}
                  {s.leftAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAsk({ type: 'back', speaker: s })}
                    >
                      Mark as back
                    </Button>
                  )}
                </div>
              )}
              {assignError && assignErrorId === s.id && pickerId !== s.id && (
                <p className="text-sm text-destructive mt-2">{assignError}</p>
              )}
            </div>
          ))}
          {playingId &&
            (() => {
              const sp = speakers.find((s) => s.id === playingId);
              if (!sp?.enrollmentAudioUrl) return null;
              return (
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    Enrollment sample for {sp.name}
                  </p>
                  <audio src={sp.enrollmentAudioUrl} controls autoPlay className="w-full" />
                </div>
              );
            })()}
        </div>
      )}

      {assignError && assignErrorId === null && (
        <p className="text-sm text-destructive mt-3">{assignError}</p>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Past meetings will show this voice as Unknown speaker. This can’t be undone. If this
              person has left and their name should stay on old meetings, mark them as left instead.
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

      <AlertDialog open={!!ask} onOpenChange={(open) => !open && !busy && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ask?.type === 'matches'
                ? 'That name already exists'
                : ask?.type === 'back'
                  ? `Mark ${ask.speaker.name} as back?`
                  : ask?.type === 'leave'
                  ? `Mark ${ask.speaker.name} as left?`
                  : ask?.type === 'undo'
                    ? 'Undo this change?'
                    : 'Assign this voice?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-2">
                {ask?.type === 'preview' && ask.preview.action === 'merge' && (
                  <p>
                    Merge “{ask.preview.source.name}” into {ask.preview.target?.name}
                    {ask.preview.target ? ` (${personHint(ask.preview.target)})` : ''}? Every past
                    meeting that used this voice will show {ask.preview.target?.name}, and future
                    meetings will recognise the voice as that person. The summary is not rewritten.
                    You can undo this for {ask.preview.undoMinutes} minutes.
                  </p>
                )}
                {ask?.type === 'preview' && ask.preview.action === 'rename' && (
                  <p>
                    Name this voice “{ask.preview.name}”? Every past meeting that used it will show
                    that name, and future meetings will recognise the voice as that person. The
                    summary is not rewritten. You can undo this for {ask.preview.undoMinutes}{' '}
                    minutes.
                  </p>
                )}
                {ask?.type === 'matches' && (
                  <>
                    <p>
                      “{ask.name}” is already saved
                      {ask.matches.length > 1 ? ` for ${ask.matches.length} people` : ''}. Merge
                      this voice into that person instead of adding another.
                    </p>
                    <ul className="space-y-2">
                      {ask.matches.map((m) => (
                        <li key={m.id}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            disabled={busy}
                            onClick={() => confirmAssign(ask.speakerId, { personId: m.id })}
                          >
                            Merge into {optionLabel(m)}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {ask?.type === 'leave' && (
                  <p>
                    Past meetings keep the name {ask.speaker.name}. New meetings will not match this
                    voice automatically. You can mark them as back later.
                  </p>
                )}
                {ask?.type === 'back' && (
                  <p>New meetings will match {ask.speaker.name}’s voice again.</p>
                )}
                {ask?.type === 'undo' && (
                  <p>
                    {ask.undo.label}. Speaker names in past meetings go back to what they were,
                    including the summary text from before the change.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {ask?.type === 'preview' && (
              <AlertDialogAction
                disabled={busy}
                onClick={() => confirmAssign(ask.speakerId, ask.body)}
              >
                Confirm
              </AlertDialogAction>
            )}
            {ask?.type === 'leave' && (
              <AlertDialogAction disabled={busy} onClick={() => confirmLeave(ask.speaker)}>
                Mark as left
              </AlertDialogAction>
            )}
            {ask?.type === 'back' && (
              <AlertDialogAction disabled={busy} onClick={() => confirmBack(ask.speaker)}>
                Mark as back
              </AlertDialogAction>
            )}
            {ask?.type === 'undo' && (
              <AlertDialogAction disabled={busy} onClick={() => confirmUndo(ask.undo)}>
                Undo
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
