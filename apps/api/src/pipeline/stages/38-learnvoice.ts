import { learnConfirmedVoices } from '../../services/identity/enroll.js';
import type { StageContext, StageHandler } from '../context.js';

/**
 * Learn the voices a person named or confirmed on the review screen into their profiles. Runs beside the
 * meeting's own pipeline and never touches the meeting's status: if it keeps failing, the names stay and only
 * the learning is missing (it runs again the next time a voice of the meeting is confirmed).
 */
export const learnvoiceStage: StageHandler = {
  async run({ job, log }: StageContext) {
    // a voice confirmed while this job was already running is picked up by the next pass
    for (let pass = 0; pass < 3; pass++) {
      const added = await learnConfirmedVoices(String(job.meetingId), (m) => log.info(m));
      log.info({ added, pass }, 'confirmed voices learned');
      if (!added) break;
    }
  },
  async onGiveUp({ log }, err) {
    log.warn({ err: err.message }, 'learning confirmed voices failed; names are kept');
  },
};
