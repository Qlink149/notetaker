import { parseArgs } from 'node:util';
import { MeetingModel } from '../../models/index.js';
import { identifyMeeting } from '../../services/identity/enroll.js';
import { applyNames, installJoin } from '../../services/identity/identity.js';
import { connect, meetingIds, run } from './lib.js';

// Cross-meeting identity (Block 2). For each meeting in the given order: install the pyannote join,
// identify its voices against everyone heard so far, give new voices anonymous people with
// voiceprints, and apply names. Reuses stored pyannote jobs; a new identify job is submitted only
// when the set of known voiceprints changed.
//   npm run p2:identity -w @meetingid/api -- 21-9 AOM Prachar 200 [--min-score 60] [--min-margin 10]
run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      submit: { type: 'boolean' },
      'min-score': { type: 'string', default: '60' },
      'min-margin': { type: 'string', default: '10' },
    },
  });
  await connect();
  const thresholds = {
    minScore: Number(values['min-score']),
    minMargin: Number(values['min-margin']),
  };
  for (const m of meetingIds(positionals)) {
    const meeting = await MeetingModel.findById(m.id).lean();
    if (!meeting) continue;
    const inst = await installJoin(m.id);
    console.log(
      `\n== ${m.name}: join ${inst.installed ? `installed (${inst.speakers} speakers, ${inst.lines} lines)` : `not installed: ${inst.reason}`}`,
    );
    const r = await identifyMeeting(m.id, String(meeting.workspaceId), {
      thresholds,
      submitNew: values.submit === true,
      log: (x) => console.log(`   ${x}`),
    });
    console.log(
      `   voiceprints sent: ${r.voiceprintsSent}${r.jobId ? `, identify job ${r.jobId}` : ' (none known yet)'}`,
    );
    for (const c of r.cards) {
      const res = r.resolutions[c.diar];
      console.log(
        `   ${c.label.padEnd(10)} ${String(c.speakerSec).padStart(7)}s  ${c.status.padEnd(6)} ` +
          (c.match
            ? `= ${c.match.name} (score ${c.match.score}, margin ${c.match.margin})`
            : c.candidate
              ? `closest ${c.candidate.name} score ${c.candidate.score} [${c.candidate.status}]`
              : res?.status === 'no-voiceprints'
                ? 'first time heard'
                : 'no close match') +
          `  clips ${c.clips.length}`,
      );
    }
    if (r.newPeople.length) console.log(`   new people: ${r.newPeople.join(', ')}`);
    for (const w of r.warnings) console.log(`   WARNING: ${w}`);
    await applyNames(m.id);
  }
});
