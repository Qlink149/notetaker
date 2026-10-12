import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { env, requireEnv } from '../../config/env.js';
import { createB2Storage, isB2Url } from '../../services/storage/b2.js';
import { cloudinaryStorage } from '../../services/storage/cloudinary.js';

// Move recordings (and voice samples) that are stored on Cloudinary to Backblaze B2 and rewrite the
// database references, in the database given by --uri-env / --db (default: the production database).
// Per file: download, upload to B2, check the stored size equals the downloaded size, and only then
// update the document. The old address is kept next to the new one (`audio.legacy`,
// `voiceprints[].legacyAudioUrl`) so a change can be undone, and nothing is deleted from Cloudinary.
// Safe to repeat: references that are already b2:// are skipped. Dry run unless --apply.
//
//   npm run migrate:audio -w @meetingid/api -- [--uri-env MONGODB_URI_PROD] [--db meetingid_prod] [--apply]
async function download(url: string, dest: string): Promise<number> {
  await cloudinaryStorage.download(url, dest);
  return (await stat(dest)).size;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'uri-env': { type: 'string', default: 'MONGODB_URI_PROD' },
      db: { type: 'string', default: 'meetingid_prod' },
      apply: { type: 'boolean' },
    },
  });
  const uri = process.env[values['uri-env']!];
  if (!uri) throw new Error(`${values['uri-env']} is not set`);
  const storage = createB2Storage({
    bucket: requireEnv('B2_BUCKET'),
    endpoint: requireEnv('B2_ENDPOINT'),
    ...(env().B2_REGION ? { region: env().B2_REGION as string } : {}),
    keyId: requireEnv('B2_KEY_ID'),
    applicationKey: requireEnv('B2_APPLICATION_KEY'),
  });
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 20000 }).asPromise();
  const db = conn.getClient().db(values.db);
  const tmp = await mkdtemp(join(tmpdir(), 'b2-migrate-'));
  const apply = values.apply === true;
  console.log(`database ${values.db}: ${apply ? 'APPLYING' : 'dry run'}`);

  const move = async (url: string, key: string, label: string): Promise<boolean> => {
    const file = join(tmp, 'f');
    const bytes = await download(url, file);
    if (!apply) {
      console.log(`  would move ${label}: ${(bytes / 1048576).toFixed(1)} MB -> ${key}`);
      return false;
    }
    await storage.uploadAudio(file, key);
    // a presigned link is valid for GET only, so ask for the first byte and read the total from Content-Range
    const head = await fetch(await storage.presignGet!(key, 300), { headers: { Range: 'bytes=0-0' } });
    await head.arrayBuffer();
    const stored = Number(/\/(\d+)$/.exec(head.headers.get('content-range') ?? '')?.[1]);
    if (!head.ok || stored !== bytes)
      throw new Error(`${label}: stored size ${stored} (HTTP ${head.status}) differs from ${bytes}; not updating the database`);
    console.log(`  moved ${label}: ${(bytes / 1048576).toFixed(1)} MB, size verified -> ${key}`);
    return true;
  };

  try {
    const slugOf = new Map<string, string>(
      (await db.collection('workspaces').find().toArray()).map((w) => [String(w._id), String(w.slug)]),
    );
    // meetings
    let moved = 0;
    for (const m of await db.collection('meetings').find().toArray()) {
      const url: string | undefined = m.audio?.originalUrl;
      if (!url || isB2Url(url)) continue;
      const slug = slugOf.get(String(m.workspaceId)) ?? 'workspace';
      const key = `workspaces/${slug}/meetings/${String(m._id)}/original-migrated`;
      if (await move(url, key, `meeting "${m.title}"`)) {
        await db.collection('meetings').updateOne(
          { _id: m._id },
          {
            $set: {
              'audio.originalUrl': `b2://${key}`,
              'audio.originalPublicId': key,
              'audio.playbackUrl': '',
              'audio.legacy': {
                originalUrl: url,
                originalPublicId: m.audio.originalPublicId ?? null,
                playbackUrl: m.audio.playbackUrl ?? null,
                migratedAt: new Date(),
              },
            },
          },
        );
        moved++;
      }
    }
    // voice samples
    for (const s of await db.collection('speakers').find().toArray()) {
      const slug = slugOf.get(String(s.workspaceId)) ?? 'workspace';
      for (const v of (s.voiceprints ?? []) as { id: string; audioUrl?: string }[]) {
        const url = v.audioUrl;
        if (!url || isB2Url(url) || !/^https?:\/\//.test(url)) continue;
        const ext = /\.(wav|mp3|m4a|webm|flac|ogg)(\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'wav';
        const key = `workspaces/${slug}/speakers/migrated/${String(s._id)}-${v.id}.${ext}`;
        if (await move(url, key, `voice sample of "${s.name}"`)) {
          await db.collection('speakers').updateOne(
            { _id: s._id },
            { $set: { 'voiceprints.$[v].audioUrl': `b2://${key}`, 'voiceprints.$[v].legacyAudioUrl': url } },
            { arrayFilters: [{ 'v.id': v.id }] },
          );
          moved++;
        }
      }
    }
    console.log(apply ? `\nmoved ${moved} file(s)` : '\nnothing written (dry run). Add --apply to move the files.');
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await conn.close();
  }
}

main().catch((err: unknown) => {
  console.error(String((err as Error).message ?? err).replace(/(mongodb(\+srv)?:\/\/)[^@\s]+@/g, '$1***@'));
  process.exit(1);
});
