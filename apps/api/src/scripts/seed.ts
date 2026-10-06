import type { GlossaryEntry } from '@meetingid/shared';
import { defaultWorkspaceSettings } from '@meetingid/shared';
import { env, requireEnv } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { hashAccessCode } from '../lib/auth.js';
import { GlossaryModel, WorkspaceModel } from '../models/index.js';

// Seed (or update) the Phase 1 workspace and its glossary. Safe to run repeatedly:
//   npm run seed -w apps/api
// Uses WORKSPACE_ACCESS_CODE from .env as the login code.

const WORKSPACE = { name: 'notetaker', slug: 'notetaker' };

export const SEED_GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Kisna',
    kind: 'company',
    aliases: ['Kisna Diamond & Gold', 'Kisna Diamond and Gold Jewellery'],
    note: 'the client; never "Kismet"',
  },
  { term: 'Hari Krishna Group', kind: 'company', aliases: [] },
  { term: 'Ghanshyam Dholakia', kind: 'person', aliases: [] },
  { term: 'Heet Dholakia', kind: 'person', aliases: [] },
  { term: 'CaratLane', kind: 'competitor', aliases: ['Carat Lane'] },
  { term: 'Tanishq', kind: 'competitor', aliases: [] },
  { term: 'Malabar', kind: 'competitor', aliases: ['Malabar Gold & Diamonds'] },
  { term: 'BlueStone', kind: 'competitor', aliases: [] },
  { term: 'Kalyan', kind: 'competitor', aliases: ['Kalyan Jewellers'] },
  { term: 'Reddy', kind: 'person', aliases: [] },
];

async function main(): Promise<void> {
  const cfg = env();
  const code = requireEnv('WORKSPACE_ACCESS_CODE');
  await connectMongo(cfg.MONGODB_URI);

  const existing = await WorkspaceModel.findOne({ slug: WORKSPACE.slug });
  const workspace =
    existing ??
    (await WorkspaceModel.create({
      ...WORKSPACE,
      accessCodeHash: hashAccessCode(code),
      settings: defaultWorkspaceSettings(),
    }));
  if (existing) {
    // Keep the code in sync with .env; bumping tokenVersion signs everyone out.
    existing.accessCodeHash = hashAccessCode(code);
    existing.tokenVersion += 1;
    await existing.save();
  }

  const glossary = await GlossaryModel.findOne({ workspaceId: workspace._id });
  if (!glossary) {
    await GlossaryModel.create({ workspaceId: workspace._id, entries: SEED_GLOSSARY });
  } else {
    // Add missing seed terms; never overwrite terms edited in the UI.
    const have = new Set(glossary.entries.map((e) => e.term.toLowerCase()));
    const missing = SEED_GLOSSARY.filter((e) => !have.has(e.term.toLowerCase()));
    if (missing.length) {
      glossary.entries.push(...missing);
      await glossary.save();
    }
  }
  console.log(
    `Seeded workspace "${workspace.name}" (${String(workspace._id)}) with ${SEED_GLOSSARY.length} glossary terms.`,
  );
  await disconnectMongo();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectMongo().catch(() => undefined);
  process.exit(1);
});
