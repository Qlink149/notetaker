import type { GlossaryEntry } from '@meetingid/shared';
import { defaultWorkspaceSettings } from '@meetingid/shared';
import { env, requireEnv } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { hashAccessCode, verifyAccessCode } from '../lib/auth.js';
import { GlossaryModel, WorkspaceModel } from '../models/index.js';

// Seed (or update) the Phase 1 workspace and its glossary. Safe to run repeatedly:
//   npm run seed -w @meetingid/api
// Uses WORKSPACE_ACCESS_CODE from .env as the login code; only a hash is stored.

export const WORKSPACE = { name: 'Kisna', slug: 'kisna' };
/** Earlier seeds used this slug; it is renamed in place so meetings keep their workspace. */
const LEGACY_SLUGS = ['notetaker'];

export const SEED_GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Kisna',
    kind: 'company',
    aliases: ['Kisna Diamond & Gold', 'KISNA'],
    note: 'the client; never "Kismet"',
  },
  { term: 'Hari Krishna Group', kind: 'company', aliases: [], note: 'parent group of Kisna' },
  { term: 'Ghanshyam Dholakia', kind: 'person', aliases: [] },
  { term: 'Heet Dholakia', kind: 'person', aliases: [] },
  { term: 'Parag', kind: 'person', aliases: [] },
  { term: 'Reddy', kind: 'person', aliases: [] },
  { term: 'Robin', kind: 'person', aliases: [] },
  { term: 'CaratLane', kind: 'competitor', aliases: ['Carat Lane'] },
  { term: 'Tanishq', kind: 'competitor', aliases: [] },
  { term: 'Malabar', kind: 'competitor', aliases: ['Malabar Gold & Diamonds'] },
  { term: 'BlueStone', kind: 'competitor', aliases: [] },
  { term: 'Kalyan', kind: 'competitor', aliases: ['Kalyan Jewellers'] },
  { term: 'Titan', kind: 'competitor', aliases: [] },
  { term: 'Reliance Jewels', kind: 'competitor', aliases: [] },
  { term: 'ORA', kind: 'competitor', aliases: ['Aura', 'Evara'] },
  { term: 'Prachar', kind: 'agency', aliases: [] },
];

async function main(): Promise<void> {
  const cfg = env();
  const code = requireEnv('WORKSPACE_ACCESS_CODE');
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);

  let workspace =
    (await WorkspaceModel.findOne({ slug: WORKSPACE.slug })) ??
    (await WorkspaceModel.findOne({ slug: { $in: LEGACY_SLUGS } }));
  if (!workspace) {
    workspace = await WorkspaceModel.create({
      ...WORKSPACE,
      accessCodeHash: hashAccessCode(code),
      settings: { ...defaultWorkspaceSettings(), languages: ['hi', 'gu', 'en'] },
    });
  } else {
    workspace.name = WORKSPACE.name;
    workspace.slug = WORKSPACE.slug;
    // Re-hash only when the code changed; bumping tokenVersion signs everyone out.
    if (!verifyAccessCode(code, workspace.accessCodeHash)) {
      workspace.accessCodeHash = hashAccessCode(code);
      workspace.tokenVersion += 1;
    }
    await workspace.save();
  }

  const glossary = await GlossaryModel.findOne({ workspaceId: workspace._id });
  let added = SEED_GLOSSARY.length;
  if (!glossary) {
    await GlossaryModel.create({ workspaceId: workspace._id, entries: SEED_GLOSSARY });
  } else {
    // Add missing seed terms; never overwrite terms edited in the UI.
    const have = new Set(glossary.entries.map((e) => e.term.toLowerCase()));
    const missing = SEED_GLOSSARY.filter((e) => !have.has(e.term.toLowerCase()));
    added = missing.length;
    if (missing.length) {
      glossary.entries.push(...missing);
      await glossary.save();
    }
  }
  console.log(
    `Seeded workspace "${workspace.name}" (slug ${workspace.slug}); ${added} glossary terms added.`,
  );
  await disconnectMongo();
}

// Run only when executed directly (show-prompts imports SEED_GLOSSARY).
if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  main().catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    await disconnectMongo().catch(() => undefined);
    process.exit(1);
  });
}
