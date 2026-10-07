import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { connectMongo, disconnectMongo } from '../../db/mongo.js';
import { phase2Models } from '../../models/phase2.js';

/** The four Phase 2 test meetings (the Phase 1 acceptance runs). */
export const TEST_MEETINGS = {
  '21-9': '6ac63b70817f752ec6823d77',
  '200': '6ac642b7bd539faa9b0edf01',
  AOM: '6ac642c6de4a83196f911555',
  Prachar: '6ac642d7553538f02ad7474a',
} as const;
export type TestMeeting = keyof typeof TEST_MEETINGS;

/** Phase 1 Gemini distinct-speaker counts (PHASE1_REPORT). */
export const PHASE1_SPEAKERS: Record<TestMeeting, number | null> = {
  '21-9': 11,
  '200': 11,
  AOM: 18,
  Prachar: null,
};

/** Resolve CLI names ("21-9", "AOM", "all") or raw ids to meeting ids. */
export function meetingIds(args: string[]): { name: string; id: string }[] {
  const names = args.length === 0 || args.includes('all') ? Object.keys(TEST_MEETINGS) : args;
  return names.map((n) => {
    const id = (TEST_MEETINGS as Record<string, string>)[n] ?? n;
    if (!Types.ObjectId.isValid(id)) throw new Error(`unknown meeting: ${n}`);
    const name = Object.entries(TEST_MEETINGS).find(([, v]) => v === id)?.[0] ?? id;
    return { name, id };
  });
}

export async function connect(): Promise<void> {
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  await Promise.all(phase2Models.map((m) => m.createIndexes()));
}

export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main();
    await disconnectMongo();
  } catch (err) {
    console.error(err);
    await disconnectMongo().catch(() => undefined);
    process.exit(1);
  }
}

export * from '../../services/pyannote/jobs.js';
