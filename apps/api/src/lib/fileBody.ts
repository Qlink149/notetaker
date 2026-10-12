import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/**
 * A file as a streamed request body, so an upload never holds the whole recording in memory (a
 * 70-minute FLAC is over 100 MB, and a copy or two of it exhausted a 512 MB instance). Spread
 * `init` into the fetch options: it sets Content-Length (storage and Deepgram need it) and duplex.
 */
export async function fileBody(path: string): Promise<{
  body: ReadableStream<Uint8Array>;
  init: { duplex: 'half'; headers: Record<string, string> };
}> {
  const { size } = await stat(path);
  return {
    body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>,
    init: { duplex: 'half', headers: { 'Content-Length': String(size) } },
  };
}
