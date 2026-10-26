import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Play,
  Check,
  AlertTriangle,
  Loader2,
  Users,
  Link2,
  GitMerge,
  ScanFace,
  Mic,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api } from '@/api/client';
import { fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import PersonPicker from '@/components/PersonPicker';

const STATUS = {
  solid: { label: 'Matched by voice', cls: 'bg-emerald-100 text-emerald-700' },
  review: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800' },
  new: { label: 'New voice', cls: 'bg-sky-100 text-sky-700' },
  manual: { label: 'Merged or split by hand', cls: 'bg-violet-100 text-violet-700' },
};
const NAMED = { label: 'Named by hand', cls: 'bg-violet-100 text-violet-700' };

/** The badge says who decided the name: a person, or the voice match. */
export function statusOf(card) {
  if (card.confirmed) return NAMED;
  if (card.status === 'solid' && !card.match) return NAMED; // named before confirmations were recorded
  return STATUS[card.status] ?? STATUS.new;
}

const PALETTE = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-purple-100 text-purple-700',
  'bg-rose-100 text-rose-700',
  'bg-cyan-100 text-cyan-700',
  'bg-indigo-100 text-indigo-700',
];
export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function fmtSec(s) {
  const m = Math.round(s / 60);
  return m >= 1 ? `${m} min` : `${Math.round(s)} s`;
}

function SpeakerCardView({
  meetingId,
  card,
  others,
  people = [],
  onPlay,
  onLocate,
  onAssignClip,
  onChanged,
}) {
  const [name, setName] = useState('');
  const [everywhere, setEverywhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState(null);
  const [mergeQuery, setMergeQuery] = useState('');
  const [mergeChoice, setMergeChoice] = useState(null);
  const [note, setNote] = useState('');
  const [movingClip, setMovingClip] = useState(-1);
  const [clipDraft, setClipDraft] = useState('');
  const status = statusOf(card);
  const possible =
    !card.match &&
    !card.confirmed &&
    card.candidate?.status === 'possible' &&
    card.candidate.personId
      ? card.candidate
      : null;

  const save = async (extra = {}) => {
    const value = (extra.name ?? name).trim();
    if (!value) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const payload = { name: value, ...extra };
      // The checkbox is for Save. Linking this recording to someone, or keeping the typed name as a
      // different person, must not rename the previous profile in other meetings.
      if (everywhere && !extra.usePersonId && !extra.createNew) payload.renameEverywhere = true;
      const r = await api.meetings.nameSpeaker(meetingId, card.diar, payload);
      if (r.similar) {
        setSimilar({ typed: value, options: r.similar });
        return;
      }
      setSimilar(null);
      setName('');
      const n = (r.updatedMeetings ?? []).filter((m) => m !== meetingId).length;
      setNote(n > 0 ? `Also updated in ${n} other meeting${n > 1 ? 's' : ''}.` : '');
      await onChanged();
    } catch (e) {
      setError(e?.message || 'Could not save the name.');
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    if (!mergeChoice || mergeChoice.type === 'new') return;
    setBusy(true);
    setError('');
    try {
      await api.meetings.mergeSpeakers(
        meetingId,
        card.diar,
        mergeChoice.type === 'person' ? { personId: mergeChoice.personId } : mergeChoice.diar,
      );
      setMergeQuery('');
      setMergeChoice(null);
      await onChanged();
    } catch (e) {
      setError(e?.message || 'Could not merge.');
    } finally {
      setBusy(false);
    }
  };

  const canMerge = others.length > 0 || people.some((p) => !p.anonymous && p.id !== card.personId);

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colorFor(card.displayName)}`}
        >
          {card.displayName}
        </span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${status.cls}`}>
          {status.label}
        </span>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {fmtSec(card.speakerSec)} of speech
        </span>
      </div>

      {card.match && (
        <div className="text-xs text-foreground flex items-start gap-1.5 flex-wrap">
          <Link2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" />
          <span>
            Same voice as <b>{card.match.name}</b> · match score {card.match.score}
            <span className="text-muted-foreground">
              {' '}
              (next best is {Math.round(card.match.score - card.match.margin)})
            </span>
          </span>
          {!card.confirmed && (
            <button
              className="ml-auto underline text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onClick={() => save({ name: card.match.name, usePersonId: card.personId })}
            >
              Confirm
            </button>
          )}
        </div>
      )}
      {possible && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs space-y-2">
          <p className="text-amber-900">
            Possibly <b>{possible.name}</b> (score {possible.score}). Not named automatically
            because the voice match is not strong enough. Yes names every clip in this group. Move
            one clip if only that clip is someone else.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => save({ name: possible.name, usePersonId: possible.personId })}
          >
            Yes, it's {possible.name}
          </Button>
        </div>
      )}
      {!card.match && !card.confirmed && !possible && card.candidate && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
          <span>
            Closest known voice: {card.candidate.name} (score {card.candidate.score}), not confident
            enough to link.
          </span>
        </p>
      )}
      {card.phone && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Mic className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Mostly closest to <b className="text-foreground">{card.phone.name}</b>'s phone (
            {card.phone.attributed} of {card.phone.total} segments). A hint only; it never changes a
            name.
          </span>
        </p>
      )}
      {card.appearsIn.length > 0 && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Users className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Also heard in{' '}
            {card.appearsIn.map((a, i) => (
              <span key={a.meetingId}>
                {i > 0 && ', '}
                <Link to={`/meetings/${a.meetingId}`} className="underline">
                  {a.title}
                </Link>{' '}
                as {a.label}
                {a.score != null ? ` (${a.score})` : ''}
              </span>
            ))}
          </span>
        </p>
      )}

      {card.clips.length > 0 ? (
        <div className="space-y-1.5">
          {card.clips.map((c, i) => (
            <div key={`${c.start}-${i}`} className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => {
                    onPlay(c.start, c.end);
                    onLocate?.(c.start);
                  }}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-border hover:bg-secondary"
                  aria-label={`Play sample ${i + 1} of ${card.displayName}`}
                >
                  <Play className="w-3 h-3" /> {fmtTime(c.start)} · {Math.round(c.end - c.start)} s
                </button>
                {onAssignClip && movingClip !== i && (
                  <button
                    type="button"
                    className="text-xs underline text-muted-foreground hover:text-foreground"
                    aria-label={`Move clip at ${fmtTime(c.start)}`}
                    onClick={() => {
                      setMovingClip(i);
                      setClipDraft('');
                    }}
                  >
                    Move
                  </button>
                )}
              </div>
              {onAssignClip && movingClip === i && (
                <PersonPicker
                  startOpen
                  value={clipDraft}
                  onChange={setClipDraft}
                  people={people}
                  speakers={[card, ...others]}
                  excludeName={card.displayName}
                  disabled={busy}
                  ariaLabel={`Move clip at ${fmtTime(c.start)} to`}
                  placeholder="Search people or type a new name"
                  onCommit={(choice) => onAssignClip(c, choice)}
                  onDone={() => setMovingClip(-1)}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No clean single-speaker sample of 6 s or more.
        </p>
      )}

      <div className="flex gap-2 items-start">
        <PersonPicker
          value={name}
          onChange={setName}
          people={people}
          includeMeetingSpeakers={false}
          disabled={busy}
          ariaLabel={`Name for ${card.displayName}`}
          inputClassName="h-9 text-sm"
          placeholder="Search saved people, or type a new name"
          onSubmit={() => save()}
          onCommit={(choice) => {
            if (choice.type === 'person')
              return save({ name: choice.name, usePersonId: choice.personId });
            if (choice.type === 'new')
              return save({
                name: choice.name,
                ...(choice.createNew ? { createNew: true } : {}),
              });
            return save({ name: choice.name });
          }}
        />
        <Button size="sm" disabled={busy || !name.trim()} onClick={() => save()}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          <span className="ml-1">Save</span>
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Save renames this whole voice in this recording. A name that matches someone already saved
        asks before a second person is created.
        {card.appearsIn.length > 0
          ? ' Tick the box to rename that person in every meeting, including tasks that use this name.'
          : ' Other meetings stay as they are.'}
      </p>
      {card.appearsIn.length > 0 && (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={everywhere}
            onChange={(e) => setEverywhere(e.target.checked)}
          />
          <span>Rename in every meeting this voice is in, including tasks that use this name</span>
        </label>
      )}

      {similar && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs space-y-2">
          <p className="text-amber-900">
            “{similar.typed}” looks like someone you already have. Is it the same person?
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {similar.options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => save({ name: similar.typed, usePersonId: o.id })}
              >
                Yes, {o.name}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => save({ name: similar.typed, createNew: true })}
            >
              No, a different person
            </Button>
          </div>
        </div>
      )}

      {canMerge && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Same person as someone else? Search saved people and voices in this meeting. Merge
            combines the two identities, including their other meetings and tasks. To change only
            this recording, use Save. Moving one clip does not merge.
          </p>
          <div className="flex gap-2 items-start">
            <PersonPicker
              allowCreate={false}
              value={mergeQuery}
              onChange={(value) => {
                setMergeQuery(value);
                setMergeChoice(null);
              }}
              onCommit={(choice) => {
                if (choice.type === 'new') return;
                setMergeChoice(choice);
                setMergeQuery(choice.name);
              }}
              people={people}
              speakers={[card, ...others]}
              excludeName={card.displayName}
              disabled={busy}
              ariaLabel={`Merge ${card.displayName} with`}
              placeholder="Search people to merge with"
            />
            <Button size="sm" variant="outline" disabled={busy || !mergeChoice} onClick={merge}>
              <GitMerge className="w-3.5 h-3.5 mr-1" /> Merge
            </Button>
          </div>
        </div>
      )}

      {note && <p className="text-xs text-emerald-700">{note}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Speaker cards for one meeting: samples to listen to, who the voice matches, rename / merge. */
/**
 * Shown when the speakers were guessed from the text (the voice analysis did not run): the number of
 * speakers and who said what may be wrong, and the person can run the voice analysis again.
 */
export function TextSpeakersNotice({ onRerun, busy }) {
  return (
    <section
      className="mb-6 rounded-xl border border-border bg-secondary p-4 text-sm"
      aria-label="Speaker detection"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="w-4 h-4 text-muted-foreground" />
        Speakers were guessed from the text, not from voices.
      </p>
      <p className="mt-1 text-muted-foreground">
        The voice analysis did not run for this recording, so the number of speakers and who said
        what may be wrong. Running it again takes a few minutes and rebuilds the transcript.
      </p>
      <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={onRerun}>
        {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
        Re-run voice analysis
      </Button>
    </section>
  );
}

export default function SpeakerReview({
  meetingId,
  source,
  cards,
  autoMerged = [],
  people = [],
  onPlay,
  onLocate,
  onAssignClip,
  onChanged,
}) {
  // Closed until asked for: the speaker list is a working area, not the first thing to read.
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reidentify = async () => {
    setBusy(true);
    setMessage('');
    try {
      const r = await api.meetings.reidentify(meetingId);
      setMessage(
        r.changes.length
          ? `Updated ${r.changes.map((c) => `${c.speaker} → ${c.person} (${c.score})`).join(', ')}.`
          : "Checked against today's voiceprints: nothing changed.",
      );
      await onChanged();
    } catch (e) {
      setMessage(e?.message || 'Re-identify failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!cards?.length) return null;
  return (
    <section className="mb-6" aria-label="Speakers">
      <div className="flex items-center justify-between mb-2 gap-2">
        <button
          className="flex items-center gap-2 font-semibold"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <ScanFace className="w-4 h-4 text-muted-foreground" />
          Speakers{open ? ` (${cards.length})` : ''}
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        {open && source === 'pyannote' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={reidentify}>
            {busy ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <ScanFace className="w-4 h-4 mr-1" />
            )}
            Re-identify speakers
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-3">
          {source !== 'pyannote' && (
            <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-2.5">
              These speaker labels come from matching text between recording chunks, not from
              voices. They can be wrong.
            </p>
          )}
          {autoMerged.length > 0 && (
            <p className="text-xs rounded-lg bg-secondary border border-border p-2.5">
              {autoMerged.length === 1
                ? 'One voice that sounded identical to another was combined with it automatically.'
                : `${autoMerged.length} voices that sounded identical to others were combined with them automatically.`}{' '}
              If two different people were combined, tell us which line to split.
            </p>
          )}
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          {cards.map((c) => (
            <SpeakerCardView
              key={c.diar}
              meetingId={meetingId}
              card={c}
              others={cards.filter((o) => o.diar !== c.diar)}
              people={people}
              onPlay={onPlay}
              onLocate={onLocate}
              onAssignClip={onAssignClip}
              onChanged={onChanged}
            />
          ))}
          <p className="text-[11px] text-muted-foreground">
            A name saved here applies to this recording. Rename in every meeting when this voice is
            that person everywhere. Merge combines two identities, including other meetings and
            their tasks. Voices you name or confirm are learned for future meetings. Move on a clip,
            or “Move this line to” on a transcript line, sends only that clip to someone in this
            meeting or any saved person.
          </p>
        </div>
      )}
    </section>
  );
}
