import { parseArgs } from 'node:util';
import { MeetingModel } from '../../models/index.js';
import { seedAudit } from '../../services/audit.js';
import { connect, meetingIds, run } from './lib.js';

// Seed the blind audit with sampled lines from the M1 and joined joins (method hidden in the UI).
//   npm run p2:audit-seed -w @meetingid/api -- [all | names…] [--per-method 15]
run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'per-method': { type: 'string', default: '15' } },
  });
  await connect();
  for (const m of meetingIds(positionals)) {
    const meeting = await MeetingModel.findById(m.id).lean();
    if (!meeting) continue;
    const n = await seedAudit(m.id, meeting.workspaceId, Number(values['per-method']));
    console.log(`${m.name}: ${n} audit items`);
  }
});
