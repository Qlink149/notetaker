import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStorage } from '../../services/storage/index.js';
import { env } from '../../config/env.js';

// Proves the configured storage works end to end with real credentials, using a tiny throw-away
// object: sign a browser upload and PUT to it, upload from the server, download back, fetch through a
// presigned link, check the link refuses a changed signature, then delete the test folder.
//   STORAGE_PROVIDER=b2 npm run storage:b2-check -w @meetingid/api
const mark = (ok: boolean, what: string): void => console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);

async function main(): Promise<void> {
  if (env().STORAGE_PROVIDER !== 'b2') throw new Error('set STORAGE_PROVIDER=b2 to check B2');
  const storage = getStorage();
  const folder = `storage-check/${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), 'b2-check-'));
  let failed = false;
  const check = (ok: boolean, what: string): void => {
    mark(ok, what);
    if (!ok) failed = true;
  };
  try {
    // 1. the browser path
    const sig = await storage.signUpload(folder);
    if (sig.provider !== 'b2') throw new Error('storage did not return a b2 signature');
    const body = Buffer.from(`browser upload ${Date.now()}`);
    const put = await fetch(sig.uploadUrl, { method: 'PUT', body });
    check(put.ok, `presigned PUT from a client (${put.status})`);
    const fromBrowser = join(dir, 'from-browser');
    await storage.download(sig.url, fromBrowser);
    check((await readFile(fromBrowser)).equals(body), 'worker downloads what the browser uploaded');
    const link = await storage.presignGet!(sig.publicId, 120);
    const viaLink = await fetch(link);
    check(
      viaLink.ok && Buffer.from(await viaLink.arrayBuffer()).equals(body),
      'presigned GET returns the file',
    );
    const range = await fetch(link, { headers: { Range: 'bytes=0-3' } });
    check(range.status === 206, `range request for seeking in the player (${range.status})`);
    const tampered = await fetch(link.replace(/X-Amz-Signature=[0-9a-f]/, 'X-Amz-Signature=0'));
    check(tampered.status === 403, `a changed signature is refused (${tampered.status})`);
    // 2. the server path
    const local = join(dir, 'server.bin');
    await writeFile(local, 'server upload');
    const up = await storage.uploadAudio(local, `${folder}/server`);
    const back = join(dir, 'server.back');
    await storage.download(up.url, back);
    check((await readFile(back, 'utf8')) === 'server upload', 'server upload and download');
  } finally {
    await storage.deleteFolder(folder);
    console.log('test folder deleted');
    await rm(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log('storage OK');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
