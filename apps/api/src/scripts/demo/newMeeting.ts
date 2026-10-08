import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import mongoose, { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { connectMongo, disconnectMongo } from '../../db/mongo.js';
import {
  EngineResponseModel,
  JobModel,
  MeetingDataModel,
  MeetingModel,
  SpeakerModel,
  SpendModel,
  WorkspaceModel,
} from '../../models/index.js';
import { P2IdentityRunModel, P2PyannoteResponseModel } from '../../models/phase2.js';
import { defaultDeps } from '../../pipeline/context.js';
import { enqueue } from '../../pipeline/queue.js';
import { Runner } from '../../pipeline/runner.js';
import { stages } from '../../pipeline/stages/index.js';
import { cloudinaryStorage, meetingFolder } from '../../services/storage/cloudinary.js';

// Bring a new recording into the demo without disturbing it.
//
//   run      create the meeting in a SCRATCH database (MONGODB_DB=meetingid_new_demo), upload the audio,
//            and run every stage there (only the Gemini keys named in --keys are available; summaries
//            use the handoff provider and wait for an answer; resume with --resume).
//   publish  copy the finished meeting, the people it introduced and its engine records into the demo
//            database (meetingid_demo). Nothing existing is overwritten or deleted.
//
//   MONGODB_DB=meetingid_new_demo npm run demo:new-meeting -w @meetingid/api -- run --file <audio> --title <title> [--keys 3] [--gapfill] [--resume]
//   MONGODB_DB=meetingid_new_demo npm run demo:new-meeting -w @meetingid/api -- publish <meetingId>
const DEMO_DB = 'meetingid_demo';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      title: { type: 'string' },
      keys: { type: 'string', default: '3' },
      gapfill: { type: 'boolean' },
      resume: { type: 'boolean' },
    },
  });
  const cmd = positionals[0];
  const cfg = env();
  if (cfg.MONGODB_DB === DEMO_DB || !cfg.MONGODB_DB.endsWith('_demo'))
    throw new Error(
      `run this against the scratch database (MONGODB_DB=meetingid_new_demo), not ${cfg.MONGODB_DB}`,
    );

  const wanted = new Set((values.keys ?? '').split(',').map((k) => `GEMINI_API_KEY${k.trim()}`));
  for (const name of Object.keys(process.env))
    if (/^GEMINI_API_KEY\d*$/.test(name) && !wanted.has(name)) delete process.env[name];
  if (!values.gapfill) process.env.GAPFILL = 'off';

  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  const client = mongoose.connection.getClient();
  const scratch = client.db(cfg.MONGODB_DB);
  const demo = client.db(DEMO_DB);

  if (cmd === 'run') {
    // the workspace and the people (with their voiceprints) are needed for naming; copy them once
    for (const model of [WorkspaceModel, SpeakerModel]) {
      const name = model.collection.name;
      if ((await scratch.collection(name).countDocuments()) === 0) {
        const docs = await demo.collection(name).find().toArray();
        if (docs.length) await scratch.collection(name).insertMany(docs);
        console.log(`copied ${docs.length} ${name} into the scratch database`);
      }
    }
    let meetingId: string;
    if (values.resume) {
      const m = await MeetingModel.findOne().sort({ createdAt: -1 }).lean();
      if (!m) throw new Error('nothing to resume');
      meetingId = String(m._id);
    } else {
      if (!values.file || !values.title) throw new Error('--file and --title are required');
      const workspace = await WorkspaceModel.findOne().lean();
      if (!workspace) throw new Error('workspace missing');
      const id = new Types.ObjectId();
      const publicId = `${meetingFolder(workspace.slug, String(id))}/original-${Date.now()}`;
      console.log(`uploading ${basename(values.file)} ...`);
      const up = await cloudinaryStorage.uploadAudio(values.file, publicId);
      await MeetingModel.create({
        _id: id,
        workspaceId: workspace._id,
        title: values.title,
        date: new Date(),
        status: 'processing',
        stage: 'ingest',
        engine: workspace.settings.engine,
        languages: workspace.settings.languages,
        expectedParticipants: null,
        audio: { originalUrl: up.url, originalPublicId: up.publicId },
      });
      await enqueue({ meetingId: id, stage: 'ingest' });
      meetingId = String(id);
      console.log(`meeting ${meetingId} created; running stages`);
    }
    const deps = defaultDeps();
    console.log(
      `engine ${deps.speakerSource}; gemini keys: ${[...wanted].join(',')}; gapfill ${process.env.GAPFILL === 'off' ? 'off' : 'on'}; summaries ${cfg.SUMMARY_PROVIDER}`,
    );
    const runner = new Runner(deps, stages, { workerId: 'demo-new-meeting', concurrency: 1 });
    for (let i = 0; i < 400; i++) {
      await runner.drain();
      const left = await JobModel.find({ status: { $in: ['queued', 'running'] } }).lean();
      if (!left.length) break;
      if (left.every((j) => j.stage === 'summarise')) break; // waits for the handoff answer
      await JobModel.updateMany(
        { status: 'queued', stage: { $ne: 'summarise' } },
        { $set: { runAfter: new Date(0) } },
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    const m = await MeetingModel.findById(meetingId).lean();
    const left = await JobModel.find({ status: { $ne: 'done' } }).lean();
    console.log(
      `meeting ${meetingId}: status ${m?.status}, stage ${m?.stage}${m?.error ? `, error: ${String(m.error)}` : ''}; ` +
        (left.length
          ? `waiting: ${left.map((j) => `${j.stage}/${j.status}`).join(', ')}`
          : 'all jobs done'),
    );
  } else if (cmd === 'publish') {
    const id = positionals[1];
    if (!id) throw new Error('usage: publish <meetingId>');
    const _id = new Types.ObjectId(id);
    const meeting = await scratch.collection(MeetingModel.collection.name).findOne({ _id });
    if (!meeting) throw new Error('meeting not found in the scratch database');
    if (meeting.status !== 'completed')
      throw new Error(`meeting is ${String(meeting.status)}, not completed`);
    const copy = async (
      model: { collection: { name: string } },
      filter: object,
    ): Promise<number> => {
      const name = model.collection.name;
      const docs = await scratch.collection(name).find(filter).toArray();
      let n = 0;
      for (const d of docs) {
        if (await demo.collection(name).findOne({ _id: d._id })) continue; // never overwrite
        await demo.collection(name).insertOne(d);
        n++;
      }
      return n;
    };
    const data = await scratch
      .collection(MeetingDataModel.collection.name)
      .findOne({ meetingId: _id });
    const personIds = new Set<string>(
      ((data?.speakerCards ?? []) as { personId: string | null }[])
        .map((c) => c.personId)
        .filter((p): p is string => Boolean(p)),
    );
    const people = await scratch
      .collection(SpeakerModel.collection.name)
      .find({ _id: { $in: [...personIds].map((p) => new Types.ObjectId(p)) } })
      .toArray();
    let newPeople = 0;
    for (const p of people) {
      const have = await demo.collection(SpeakerModel.collection.name).findOne({ _id: p._id });
      if (have) {
        // a person who already exists keeps their record; add any voiceprint this run produced
        const known = new Set((have.voiceprints as { id: string }[]).map((v) => v.id));
        const extra = (p.voiceprints as { id: string }[]).filter((v) => !known.has(v.id));
        if (extra.length)
          await demo
            .collection(SpeakerModel.collection.name)
            .updateOne({ _id: p._id }, { $push: { voiceprints: { $each: extra } } } as never);
      } else {
        await demo.collection(SpeakerModel.collection.name).insertOne(p);
        newPeople++;
      }
    }
    const counts = {
      meeting: await copy(MeetingModel, { _id }),
      meetingData: await copy(MeetingDataModel, { meetingId: _id }),
      engineResponses: await copy(EngineResponseModel, { meetingId: _id }),
      spend: await copy(SpendModel, { meetingId: _id }),
      pyannoteResponses: await copy(P2PyannoteResponseModel, { meetingId: _id }),
      identityRuns: await copy(P2IdentityRunModel, { meetingId: _id }),
      newPeople,
    };
    console.log('published to', DEMO_DB, JSON.stringify(counts));
  } else console.log('usage: run | publish <meetingId>');
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
