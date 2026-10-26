import { Router, type Request } from 'express';
import { z } from 'zod';
import { attributeSegments } from '@meetingid/pipeline';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import {
  MeetingDataModel,
  MeetingModel,
  type MeetingDoc,
  type SpeakerCardDoc,
} from '../models/index.js';
import { identifyMeeting } from '../services/identity/enroll.js';
import {
  EditError,
  SimilarPersonError,
  mergeSpeakerIntoPerson,
  mergeSpeakers,
  nameSpeaker,
  peopleSimilarTo,
  reassignLine,
  splitSpeaker,
} from '../services/identity/edits.js';
import {
  applyNames,
  displayName,
  peopleOf,
  pyannoteSegments,
  shortTitle,
} from '../services/identity/identity.js';
import { PyannoteError } from '../services/pyannote/client.js';
import { LoudnessModel, ParticipantModel, SessionModel } from '../models/session.js';
import type { ApiDeps } from './deps.js';

const NameBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** Link to this existing person instead of creating or renaming one. */
  usePersonId: z.string().optional(),
  /** Skip the similar-name check and keep the typed name as a new person. */
  createNew: z.boolean().optional(),
  /** Rename the matched person in every meeting instead of correcting this meeting's match. */
  renameEverywhere: z.boolean().optional(),
});
const MergeBody = z
  .object({
    from: z.string().min(1),
    into: z.string().min(1).optional(),
    intoPersonId: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .optional(),
  })
  .refine((b) => Number(Boolean(b.into)) + Number(Boolean(b.intoPersonId)) === 1, {
    message: 'Choose one person to merge with.',
  });
const SplitBody = z.object({ lineIndex: z.number().int().min(0) });
const ReassignBody = z
  .object({
    lineIndex: z.number().int().min(0),
    toDiar: z.string().min(1).optional(),
    toPersonId: z.string().min(1).optional(),
    toName: z.string().trim().min(1).max(100).optional(),
    createNew: z.boolean().optional(),
  })
  .refine((b) => [b.toDiar, b.toPersonId, b.toName].filter(Boolean).length === 1, {
    message: 'Choose a speaker, a saved person, or a new name.',
  });

// Speaker review (Phase 2): cards with clips and confidence, name (a correction stays in this meeting;
// renaming that person in every meeting is explicit), merge, split, reassign one line, re-identify.
export function meetingSpeakersRouter(_deps: ApiDeps): Router {
  const r = Router();

  const own = async (req: Request): Promise<MeetingDoc> => {
    const m = await MeetingModel.findOne({
      _id: idParam(req),
      workspaceId: ws(req)._id,
    }).lean<MeetingDoc>();
    if (!m) throw notFound('meeting_not_found');
    return m;
  };

  const editing = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EditError) throw new HttpError(400, err.message);
      throw err;
    }
  };

  r.get('/meetings/:id/speakers', async (req, res) => {
    const m = await own(req);
    const data = await MeetingDataModel.findOne({ meetingId: m._id }).lean();
    if (!data) throw notFound('meeting_data_not_found');
    const cards = (data.speakerCards ?? []) as SpeakerCardDoc[];
    const people = await peopleOf(cards.map((c) => c.personId));
    const personIds = cards.map((c) => c.personId).filter((x): x is string => !!x);
    const others = personIds.length
      ? await MeetingDataModel.find(
          { 'speakerCards.personId': { $in: personIds }, meetingId: { $ne: m._id } },
          { meetingId: 1, speakerCards: 1 },
        ).lean()
      : [];
    const titles = new Map(
      (
        await MeetingModel.find(
          { _id: { $in: others.map((o) => o.meetingId) } },
          { title: 1 },
        ).lean()
      ).map((x) => [String(x._id), x.title]),
    );
    // Third signal (group recordings): which phone was closest to this voice. Display only; it never
    // changes a name or overrides a voiceprint match.
    const phone = new Map<string, { name: string; attributed: number; total: number }>();
    const session = await SessionModel.findOne({ meetingId: m._id }).lean();
    if (session) {
      const [loud, people2, pya] = await Promise.all([
        LoudnessModel.find({ sessionId: session._id }).lean(),
        ParticipantModel.find({ sessionId: session._id }, { name: 1 }).lean(),
        pyannoteSegments(String(m._id)),
      ]);
      const nameOf = new Map(people2.map((p) => [String(p._id), p.name]));
      if (loud.length && pya) {
        for (const c of cards) {
          const segs = pya.segments.filter((s) => s.speaker === c.diar);
          const att = attributeSegments(
            loud.map((l) => Float32Array.from(l.db)),
            segs,
          );
          const counts = new Map<number, number>();
          for (const a of att)
            if (a.track !== null) counts.set(a.track, (counts.get(a.track) ?? 0) + 1);
          const top = [...counts].sort((x, y) => y[1] - x[1])[0];
          if (top)
            phone.set(c.diar, {
              name: nameOf.get(String(loud[top[0]]!.participantId)) ?? 'a phone',
              attributed: top[1],
              total: segs.length,
            });
        }
      }
    }
    const turnCount = new Map<string, number>();
    for (const t of data.turns) turnCount.set(t.speaker, (turnCount.get(t.speaker) ?? 0) + 1);
    res.set('Cache-Control', 'no-store').json({
      source: data.speakerSource,
      autoMerged: ((data.speakerMerges ?? []) as { from: string; into: string; manual?: boolean }[])
        .filter((x) => !x.manual)
        .map((x) => ({
          from: x.from,
          into: x.into,
          intoLabel: cards.find((c) => c.diar === x.into)?.label ?? x.into,
        })),
      cards: cards.map((c) => {
        const person = c.personId ? people.get(c.personId) : undefined;
        return {
          diar: c.diar,
          label: c.label,
          displayName: displayName(c, people),
          personId: c.personId,
          personName: person?.name ?? null,
          anonymous: person ? person.anonymous : true,
          voiceprints: person?.voiceprints.filter((v) => v.voiceprint).length ?? 0,
          speakerSec: c.speakerSec,
          turns: turnCount.get(c.diar) ?? 0,
          phone: phone.get(c.diar) ?? null,
          status: c.status,
          confirmed: c.confirmed === true,
          // the matched person's current name, not the placeholder they had when matched
          match: c.match
            ? {
                ...c.match,
                name: (c.match.personId === c.personId ? person?.name : undefined) ?? c.match.name,
              }
            : null,
          candidate: c.candidate,
          clips: c.clips,
          appearsIn: others.flatMap((o) =>
            ((o.speakerCards ?? []) as SpeakerCardDoc[])
              .filter((oc) => oc.personId === c.personId)
              .map((oc) => ({
                meetingId: String(o.meetingId),
                title: shortTitle(titles.get(String(o.meetingId)) ?? ''),
                label: oc.label,
                displayName: displayName(oc, people),
                score: oc.match?.score ?? c.match?.score ?? null,
              })),
          ),
        };
      }),
    });
  });

  r.post('/meetings/:id/speakers/:diar/name', async (req, res) => {
    const m = await own(req);
    const { name, usePersonId, createNew, renameEverywhere } = body(NameBody, req);
    const diar = String(req.params.diar);
    const data = await MeetingDataModel.findOne({ meetingId: m._id }, { speakerCards: 1 }).lean();
    const card = ((data?.speakerCards ?? []) as SpeakerCardDoc[]).find((c) => c.diar === diar);
    if (!card) throw notFound('speaker_not_found');
    // Typos and an extra word ("Parag Bhai" for "Parag") ask before a second profile is created.
    // Renaming the profile this card already points at (including everywhere) is the earlier path
    // and is not a new person, so it is not held back here.
    if (!usePersonId && !createNew && !renameEverywhere) {
      const similar = await peopleSimilarTo(String(ws(req)._id), name, card.personId);
      if (similar.length) {
        res.status(409).json({ error: 'similar_name', similar });
        return;
      }
    }
    const result = await editing(() =>
      nameSpeaker(String(m._id), String(ws(req)._id), diar, name, usePersonId, {
        renameEverywhere,
      }),
    );
    res.json({
      personId: result.personId,
      updatedMeetings: result.changed,
      meetingsWithThisVoice: result.meetings,
    });
  });

  r.post('/meetings/:id/speakers/merge', async (req, res) => {
    const m = await own(req);
    const { from, into, intoPersonId } = body(MergeBody, req);
    const result = await editing(() => {
      if (into) return mergeSpeakers(String(m._id), from, into);
      if (intoPersonId)
        return mergeSpeakerIntoPerson(String(m._id), String(ws(req)._id), from, intoPersonId);
      throw new EditError('Choose one person to merge with.');
    });
    res.json({ lines: result?.lines ?? 0 });
  });

  r.post('/meetings/:id/speakers/split', async (req, res) => {
    const m = await own(req);
    const { lineIndex } = body(SplitBody, req);
    const { label } = await editing(() => splitSpeaker(String(m._id), lineIndex));
    res.json({ newSpeaker: label });
  });

  r.post('/meetings/:id/lines/reassign', async (req, res) => {
    const m = await own(req);
    const { lineIndex, toDiar, toPersonId, toName, createNew } = body(ReassignBody, req);
    try {
      const result = await reassignLine(String(m._id), String(ws(req)._id), lineIndex, {
        toDiar,
        toPersonId,
        toName,
        createNew,
      });
      res.json({ lines: result?.lines ?? 0 });
    } catch (err) {
      if (err instanceof SimilarPersonError) {
        res.status(409).json({ error: 'similar_name', similar: err.similar });
        return;
      }
      if (err instanceof EditError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  /** Runs identify again with today's voiceprints; only confident new matches change anything. */
  r.post('/meetings/:id/speakers/reidentify', async (req, res) => {
    const m = await own(req);
    let report;
    try {
      report = await identifyMeeting(String(m._id), String(ws(req)._id), {
        submitNew: true,
        previewOnly: true,
      });
    } catch (err) {
      if (err instanceof PyannoteError)
        throw new HttpError(
          503,
          err.status === 402
            ? 'Speaker recognition is unavailable: the pyannote account has no credits.'
            : `Speaker recognition failed: ${err.message}`,
        );
      throw err;
    }
    const data = await MeetingDataModel.findOne({ meetingId: m._id }, { speakerCards: 1 }).lean();
    const cards = (data?.speakerCards ?? []) as SpeakerCardDoc[];
    const people = await peopleOf(Object.values(report.resolutions).map((x) => x.personId));
    const changes: { speaker: string; person: string; score: number }[] = [];
    for (const card of cards) {
      const res2 = report.resolutions[card.diar];
      if (
        !res2?.personId ||
        card.status === 'manual' ||
        card.confirmed ||
        card.personId === res2.personId
      )
        continue;
      const person = people.get(res2.personId);
      if (!person) continue;
      card.personId = res2.personId;
      card.match = {
        personId: res2.personId,
        name: person.name,
        score: res2.score,
        margin: res2.margin,
      };
      card.status = 'solid';
      changes.push({ speaker: card.label, person: person.name, score: res2.score });
    }
    if (changes.length) {
      await MeetingDataModel.updateOne({ meetingId: m._id }, { $set: { speakerCards: cards } });
      await applyNames(String(m._id));
    }
    res.json({ changes, warnings: report.warnings });
  });

  return r;
}
