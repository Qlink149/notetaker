import { Types } from 'mongoose';
import {
  EngineResponseModel,
  HandoffModel,
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  TaskModel,
  type SpeakerDoc,
} from '../models/index.js';
import {
  P2AuditModel,
  P2IdentityRunModel,
  P2JoinModel,
  P2MediaModel,
  P2PyannoteResponseModel,
} from '../models/phase2.js';
import { LoudnessModel, ParticipantModel, SessionModel } from '../models/session.js';

export interface DeletedMeeting {
  records: number;
  /** People known only from this meeting (unnamed voices, or names whose every clip came from it). */
  peopleRemoved: string[];
  /** Voice clips of this meeting taken off people who stay (they are known from other meetings too). */
  clipsRemoved: number;
}

/**
 * Remove a meeting and everything made from it: transcript data, jobs, engine and pyannote replies,
 * identification runs, the people first heard in it who are not heard anywhere else, and its voice clips
 * on everyone else. Before this, a deleted meeting's voices stayed in the speaker directory and could
 * match people in later meetings (19 Oct, a test upload left 4 voice profiles with 12 clips behind).
 * The stored audio is removed by the caller (storage is best effort).
 */
export async function deleteMeetingEverywhere(
  meetingId: string,
  workspaceId: string,
): Promise<DeletedMeeting> {
  const id = new Types.ObjectId(meetingId);
  const ws = new Types.ObjectId(workspaceId);

  // people this meeting created who appear in no other meeting and have no clips from elsewhere
  const born = await SpeakerModel.find({ workspaceId: ws, 'origin.meetingId': id }).lean<
    SpeakerDoc[]
  >();
  const remove: SpeakerDoc[] = [];
  for (const p of born) {
    const elsewhere = await MeetingDataModel.exists({
      meetingId: { $ne: id },
      'speakerCards.personId': String(p._id),
    });
    const otherClips = p.voiceprints.some((v) => String(v.meetingId) !== meetingId);
    if (!elsewhere && !otherClips) remove.push(p);
  }
  if (remove.length) await SpeakerModel.deleteMany({ _id: { $in: remove.map((p) => p._id) } });
  const pulled = await SpeakerModel.updateMany(
    { workspaceId: ws, 'voiceprints.meetingId': id },
    { $pull: { voiceprints: { meetingId: id } } },
  );

  const sessions = await SessionModel.find({ meetingId: id }, { _id: 1 }).lean();
  const sessionIds = sessions.map((s) => s._id);
  const counts = await Promise.all([
    MeetingDataModel.deleteMany({ meetingId: id }),
    JobModel.deleteMany({ meetingId: id }),
    EngineResponseModel.deleteMany({ meetingId: id }),
    P2PyannoteResponseModel.deleteMany({ meetingId: id }),
    P2MediaModel.deleteMany({ meetingId: id }),
    P2JoinModel.deleteMany({ meetingId: id }),
    P2IdentityRunModel.deleteMany({ meetingId: id }),
    P2AuditModel.deleteMany({ meetingId: id }),
    HandoffModel.deleteMany({ meetingId: id }),
    TaskModel.deleteMany({ meetingId: id }),
    LoudnessModel.deleteMany({ sessionId: { $in: sessionIds } }),
    ParticipantModel.deleteMany({ sessionId: { $in: sessionIds } }),
    SessionModel.deleteMany({ _id: { $in: sessionIds } }),
  ]);
  // the meeting itself last, so a failure above can be retried from the meeting page
  const meeting = await MeetingModel.deleteOne({ _id: id, workspaceId: ws });
  return {
    records: counts.reduce((n, r) => n + r.deletedCount, 0) + meeting.deletedCount,
    peopleRemoved: remove.map((p) => p.name),
    clipsRemoved: pulled.modifiedCount,
  };
}
