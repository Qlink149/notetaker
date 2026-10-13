import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingConfigError, resetEnvCache } from '../src/config/env.js';
import { FatalError } from '../src/pipeline/errors.js';
import { createB2Storage, isB2Url } from '../src/services/storage/b2.js';
import { getStorage, resetStorageForTest } from '../src/services/storage/index.js';

// Backblaze B2 through the S3-compatible API. Signing is pure computation, so the presigned links are
// real; every call that would reach the network is answered by a stand-in.
type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'b2-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient(handler: (c: Cmd) => unknown): { client: S3Client; sent: Cmd[] } {
  const client = new S3Client({
    region: 'us-west-004',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    credentials: { accessKeyId: 'keyid', secretAccessKey: 'secret' },
  });
  const sent: Cmd[] = [];
  client.send = (async (c: Cmd) => {
    sent.push(c);
    return handler(c);
  }) as unknown as S3Client['send'];
  return { client, sent };
}

describe('B2 storage', () => {
  it('signs a browser upload: a presigned PUT for a new key inside the meeting folder', async () => {
    const { client } = fakeClient(() => ({}));
    const s = createB2Storage({ bucket: 'bkt', client });
    const sig = await s.signUpload('workspaces/kisna/meetings/abc');
    if (sig.provider !== 'b2') throw new Error('expected a b2 signature');
    expect(sig.method).toBe('PUT');
    expect(sig.publicId.startsWith('workspaces/kisna/meetings/abc/original-')).toBe(true);
    expect(sig.url).toBe(`b2://${sig.publicId}`);
    const u = new URL(sig.uploadUrl);
    expect(u.host).toContain('backblazeb2.com');
    expect(u.pathname).toContain(sig.publicId);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(s.trimsRemotely).toBe(false);
  });

  it('two signatures never share a key', async () => {
    const s = createB2Storage({ bucket: 'bkt', client: fakeClient(() => ({})).client });
    const a = await s.signUpload('f');
    const b = await s.signUpload('f');
    expect(a.provider === 'b2' && b.provider === 'b2' && a.publicId !== b.publicId).toBe(true);
  });

  it('presigns downloads for six hours by default', async () => {
    const s = createB2Storage({ bucket: 'bkt', client: fakeClient(() => ({})).client });
    const u = new URL(await s.presignGet!('k/o'));
    expect(u.searchParams.get('X-Amz-Expires')).toBe(String(6 * 3600));
    expect(u.pathname).toContain('k/o');
  });

  it('gives the same playback link for the whole hour, carries a cache header, and keeps explicit links exact', async () => {
    const s = createB2Storage({ bucket: 'bkt', client: fakeClient(() => ({})).client });
    const a = await s.presignGet!('k/o');
    await new Promise((r) => setTimeout(r, 1100)); // a second later: the signature must not change
    const b = await s.presignGet!('k/o');
    expect(b).toBe(a);
    expect(new URL(a).searchParams.get('response-cache-control')).toBe('private, max-age=3600');
    const short = new URL(await s.presignGet!('k/o', 600));
    expect(short.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(short.searchParams.get('response-cache-control')).toBeNull();
  });

  it('uploads a file with its length and returns a b2:// address', async () => {
    const { client, sent } = fakeClient(() => ({}));
    const file = join(dir, 'a.wav');
    await writeFile(file, 'hello');
    const out = await createB2Storage({ bucket: 'bkt', client }).uploadAudio(file, 'ws/x/mix');
    expect(out).toEqual({ url: 'b2://ws/x/mix', publicId: 'ws/x/mix' });
    expect(sent[0]!.constructor.name).toBe('PutObjectCommand');
    expect(sent[0]!.input).toMatchObject({ Bucket: 'bkt', Key: 'ws/x/mix', ContentLength: 5 });
  });

  it('downloads a b2:// object as a stream to a file', async () => {
    const { client, sent } = fakeClient(() => ({
      Body: Readable.from([Buffer.from('audio-bytes')]),
    }));
    const dest = join(dir, 'o');
    await createB2Storage({ bucket: 'bkt', client }).download('b2://ws/x/original-1', dest);
    expect(await readFile(dest, 'utf8')).toBe('audio-bytes');
    expect(sent[0]!.input).toMatchObject({ Bucket: 'bkt', Key: 'ws/x/original-1' });
  });

  it('a missing object is a fatal (never retried) error', async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    });
    await expect(
      createB2Storage({ bucket: 'bkt', client }).download('b2://gone', join(dir, 'o')),
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('downloads meetings made on the old storage through it, and refuses them when there is none', async () => {
    const legacy = {
      download: vi.fn(async () => undefined),
      deleteFolder: vi.fn(async () => undefined),
    };
    const { client, sent } = fakeClient(() => ({}));
    await createB2Storage({ bucket: 'bkt', client, legacy }).download(
      'https://res.cloudinary.com/x/y.mp3',
      'd',
    );
    expect(legacy.download).toHaveBeenCalledWith('https://res.cloudinary.com/x/y.mp3', 'd');
    expect(sent).toHaveLength(0);
    await expect(
      createB2Storage({ bucket: 'bkt', client }).download(
        'https://res.cloudinary.com/x/y.mp3',
        'd',
      ),
    ).rejects.toBeInstanceOf(FatalError);
  });

  it('deletes every page of a folder in batches, then the old storage copy', async () => {
    const pages = [
      {
        Contents: [{ Key: 'f/1' }, { Key: 'f/2' }],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      { Contents: [{ Key: 'f/3' }], IsTruncated: false },
    ];
    let n = 0;
    const { client, sent } = fakeClient((c) =>
      c.constructor.name === 'ListObjectsV2Command' ? pages[n++] : {},
    );
    const legacy = { download: vi.fn(), deleteFolder: vi.fn(async () => undefined) };
    await createB2Storage({ bucket: 'bkt', client, legacy }).deleteFolder('f');
    const lists = sent.filter((c) => c.constructor.name === 'ListObjectsV2Command');
    const deletes = sent.filter((c) => c.constructor.name === 'DeleteObjectsCommand');
    expect(lists.map((c) => c.input.Prefix)).toEqual(['f/', 'f/']); // trailing slash: never a sibling folder
    expect(lists[1]!.input.ContinuationToken).toBe('t1');
    expect(deletes.map((c) => (c.input.Delete as { Objects: unknown[] }).Objects.length)).toEqual([
      2, 1,
    ]);
    expect(legacy.deleteFolder).toHaveBeenCalledWith('f');
  });

  it('cannot cut clips (callers cut them locally)', () => {
    const s = createB2Storage({ bucket: 'bkt', client: fakeClient(() => ({})).client });
    expect(() => s.trimmedWavUrl('k', 0, 1)).toThrow(/cut/);
  });

  it('recognises its own addresses', () => {
    expect(isB2Url('b2://k')).toBe(true);
    expect(isB2Url('https://res.cloudinary.com/x')).toBe(false);
    expect(isB2Url(null)).toBe(false);
  });
});

describe('storage provider switch', () => {
  const SAVED = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/unused',
      JWT_SECRET: 'x'.repeat(40),
      GEMINI_API_KEY: 'g',
    });
    for (const k of [
      'STORAGE_PROVIDER',
      'B2_BUCKET',
      'B2_KEY_ID',
      'B2_APPLICATION_KEY',
      'B2_ENDPOINT',
    ])
      delete process.env[k];
    resetEnvCache();
    resetStorageForTest();
  });
  afterEach(() => {
    process.env = { ...SAVED };
    resetEnvCache();
    resetStorageForTest();
  });

  it('is Cloudinary unless told otherwise', () => {
    expect(getStorage().trimsRemotely).toBe(true);
  });
  it('B2 needs all four settings and says which one is missing', () => {
    process.env.STORAGE_PROVIDER = 'b2';
    process.env.B2_BUCKET = 'bkt';
    resetEnvCache();
    expect(() => getStorage()).toThrow(MissingConfigError);
    expect(() => getStorage()).toThrow(/B2_KEY_ID/);
  });
  it('B2 is used when fully configured', () => {
    Object.assign(process.env, {
      STORAGE_PROVIDER: 'b2',
      B2_BUCKET: 'bkt',
      B2_KEY_ID: 'id',
      B2_APPLICATION_KEY: 'key',
      B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
    });
    resetEnvCache();
    expect(getStorage().trimsRemotely).toBe(false);
  });
});
