import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Types } from 'mongoose';
import { MeetingModel, SpeakerModel, WorkspaceModel } from '../../models/index.js';
import { toAnalysisFlac } from '../../services/audio/ffmpeg.js';
import { cloudinaryStorage } from '../../services/storage/cloudinary.js';
import { IDENTITY_MODEL } from '../../services/identity/enroll.js';
import { connect, meetingIds, run, runJob, scratchDir } from './lib.js';
import { submitVoiceprint, uploadMedia } from '../../services/pyannote/client.js';

// Add a named person from a voice sample (a single speaker, 3-30 s): converts it to 16 kHz FLAC,
// keeps a playable copy in Cloudinary, makes ONE pyannote voiceprint (the model identification
// uses) and stores it on the person. Safe to repeat: an existing voiceprint is not made twice.
//   npm run p2:enrol-sample -w @meetingid/api -- --name Heet --file C:/path/to/sample.wav
run(async () => {
  const { values } = parseArgs({
    options: { name: { type: 'string' }, file: { type: 'string' } },
  });
  if (!values.name || !values.file) throw new Error('usage: --name <name> --file <audio file>');
  await connect();
  const anyMeeting = await MeetingModel.findById(meetingIds(['AOM'])[0]!.id).lean();
  if (!anyMeeting) throw new Error('demo meetings not found');
  const workspace = await WorkspaceModel.findById(anyMeeting.workspaceId).lean();
  if (!workspace) throw new Error('workspace not found');

  const existing = await SpeakerModel.findOne({
    workspaceId: workspace._id,
    name: values.name,
  }).lean();
  if (existing?.voiceprints.some((v) => v.voiceprint && v.model === IDENTITY_MODEL)) {
    console.log(`${values.name} already has a ${IDENTITY_MODEL} voiceprint; nothing to do`);
    return;
  }

  const slug = values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const flac = scratchDir('enrol', `${slug}.flac`);
  await mkdir(resolve(flac, '..'), { recursive: true });
  await toAnalysisFlac(resolve(values.file), flac);

  const up = await cloudinaryStorage.uploadAudio(
    flac,
    `workspaces/${workspace.slug}/speakers/enrol-${slug}-${Date.now()}`,
  );
  const playbackUrl = cloudinaryStorage.trimmedWavUrl(up.publicId, 0, 600);

  const media = await uploadMedia(flac, `p2-enrol-${slug}-${Date.now()}.flac`, 'voiceprint');
  const doc = await runJob(
    {
      meetingId: null,
      kind: 'voiceprint',
      model: IDENTITY_MODEL,
      tag: `vp-enrol-${slug}`,
      body: { url: media, model: IDENTITY_MODEL },
      submit: () => submitVoiceprint(media, IDENTITY_MODEL),
    },
    (x) => console.log(`  ${x}`),
  );
  const voiceprint = (doc.output as { voiceprint?: string } | null)?.voiceprint;
  if (!voiceprint) throw new Error('pyannote returned no voiceprint');

  const entry = {
    id: new Types.ObjectId().toString(),
    source: 'enrolment' as const,
    audioUrl: playbackUrl,
    voiceprint,
    model: IDENTITY_MODEL,
    quality: null,
  };
  if (existing)
    await SpeakerModel.updateOne({ _id: existing._id }, { $push: { voiceprints: entry } });
  else
    await SpeakerModel.create({
      workspaceId: workspace._id,
      name: values.name,
      anonymous: false,
      voiceprints: [entry],
    });
  console.log(`${values.name}: voiceprint stored (${IDENTITY_MODEL}), playable sample kept`);
});
