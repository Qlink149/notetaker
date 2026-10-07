import { Router, type Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { similarNames } from '@meetingid/pipeline';
import { ws } from '../lib/auth.js';
import { HttpError, body, idParam, notFound } from '../lib/http.js';
import {
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  type MeetingDoc,
  type SpeakerCardDoc,
  type SpeakerDoc,
} from '../models/index.js';
import { identifyMeeting } from '../services/identity/enroll.js';
import {
  EditError,
  mergeSpeakers,
  nameSpeaker,
  reassignLine,
  splitSpeaker,
} from '../services/identity/edits.js';
import { applyNames, displayName, peopleOf, shortTitle } from '../services/identity/identity.js';
import { PyannoteError } from '../services/pyannote/client.js';
import type { ApiDeps } from './deps.js';

const NameBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** Link to this existing person instead of creating or renaming one. */
  usePersonId: z.string().optional(),
  /** Skip the similar-name check and keep the typed name as a new person. */
  createNew: z.boolean().optional(),
});
const MergeBody = z.object({ from: z.string(), into: z.string() });
const SplitBody = z.object({ lineIndex: z.number().int().min(0) });
const ReassignBody = z.object({ lineIndex: z.number().int().min(0), toDiar: z.string() });

// Speaker review (Phase 2): cards with clips and confidence, rename (which propagates to every
// meeting where the voice was recognised), merge, split, reassign one line, re-identify.
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
    const turnCount = new Map<string, number>();
    for (const t of data.turns) turnCount.set(t.speaker, (turnCount.get(t.speaker) ?? 0) + 1);
    res.set('Cache-Control', 'no-store').json({
      source: data.speakerSource,
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
          status: c.status,
          match: c.match,
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
    const { name, usePersonId, createNew } = body(NameBody, req);
    const diar = String(req.params.diar);
    const data = await MeetingDataModel.findOne({ meetingId: m._id }, { speakerCards: 1 }).lean();
    const card = ((data?.speakerCards ?? []) as SpeakerCardDoc[]).find((c) => c.diar === diar);
    if (!card) throw notFound('speaker_not_found');
    if (!usePersonId && !createNew) {
      const named = await SpeakerModel.find({
        workspaceId: ws(req)._id,
        anonymous: false,
        ...(card.personId ? { _id: { $ne: new Types.ObjectId(card.personId) } } : {}),
      }).lean<SpeakerDoc[]>();
      const similar = similarNames(
        name,
        named.map((p) => p.name),
      );
      if (similar.length) {
        res.status(409).json({
          error: 'similar_name',
          similar: named
            .filter((p) => similar.includes(p.name))
            .map((p) => ({ id: String(p._id), name: p.name })),
        });
        return;
      }
    }
    const result = await editing(() =>
      nameSpeaker(String(m._id), String(ws(req)._id), diar, name, usePersonId),
    );
    res.json({
      personId: result.personId,
      updatedMeetings: result.changed,
      meetingsWithThisVoice: result.meetings,
    });
  });

  r.post('/meetings/:id/speakers/merge', async (req, res) => {
    const m = await own(req);
    const { from, into } = body(MergeBody, req);
    const result = await editing(() => mergeSpeakers(String(m._id), from, into));
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
    const { lineIndex, toDiar } = body(ReassignBody, req);
    const result = await editing(() => reassignLine(String(m._id), lineIndex, toDiar));
    res.json({ lines: result?.lines ?? 0 });
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
      if (!res2?.personId || card.status === 'manual' || card.personId === res2.personId) continue;
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
