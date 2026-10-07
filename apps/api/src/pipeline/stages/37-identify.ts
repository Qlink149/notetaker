import { MeetingDataModel, MeetingModel } from '../../models/index.js';
import { identifyMeeting } from '../../services/identity/enroll.js';
import { applyNames, ensureCards } from '../../services/identity/identity.js';
import type { StageContext, StageHandler } from '../context.js';
import { loadMeeting } from '../meetings.js';
import { enqueue } from '../queue.js';

/**
 * Work out who each pyannote voice is (known people, or a new anonymous one), apply the names to
 * the lines, then hand over to the summary. Never fails the meeting: without pyannote (no credit,
 * outage) the voices stay anonymous ("Speaker A") and can be named by hand.
 */
export const identifyStage: StageHandler = {
  async run({ job, deps, log }: StageContext) {
    const meeting = await loadMeeting(job.meetingId);
    const id = String(meeting._id);
    const data = await MeetingDataModel.findOne(
      { meetingId: meeting._id },
      { speakerSource: 1 },
    ).lean();
    if (deps.speakerSource === 'pyannote' && data?.speakerSource === 'pyannote') {
      try {
        const report = await identifyMeeting(id, String(meeting.workspaceId), {
          submitNew: true,
          log: (m) => log.info(m),
        });
        log.info(
          {
            voiceprintsSent: report.voiceprintsSent,
            linked: report.linked,
            newPeople: report.newPeople.length,
            warnings: report.warnings,
          },
          'speakers identified',
        );
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'identify failed; voices stay anonymous');
      }
      try {
        await ensureCards(id);
        await applyNames(id);
      } catch (err) {
        // naming is a bonus: never let it stop the summary
        log.warn({ err: (err as Error).message }, 'could not apply speaker names');
      }
    }
    await MeetingModel.updateOne({ _id: meeting._id }, { $set: { stage: 'summarise' } });
    await enqueue({ meetingId: meeting._id, stage: 'summarise' });
  },
};
