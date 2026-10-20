import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FatalError, classify } from '../../pipeline/errors.js';
import type { StorageService } from './cloudinary.js';

// Backblaze B2 through its S3-compatible API. The bucket stays private: the browser uploads with a
// presigned PUT, the worker streams downloads, and playback goes through a signed link on our own
// API that redirects to a short-lived presigned GET (see routes/audio.ts). B2 cannot cut audio
// clips, so callers that need one cut it locally (`trimsRemotely` is false).

/** Objects are addressed as b2://<key> in the database, never by a public URL. */
export const B2_SCHEME = 'b2://';
export const isB2Url = (url: string | null | undefined): boolean =>
  typeof url === 'string' && url.startsWith(B2_SCHEME);
export const keyOfB2Url = (url: string): string => url.slice(B2_SCHEME.length);

const UPLOAD_LINK_SECONDS = 3600;
const DOWNLOAD_LINK_SECONDS = 6 * 3600;
const PLAYBACK_CACHE_SECONDS = 3600;

export interface B2Options {
  bucket: string;
  /** Tests inject a client; production builds one from the endpoint and keys. */
  client?: S3Client;
  endpoint?: string;
  region?: string;
  keyId?: string;
  applicationKey?: string;
  /** Storage used for objects that are not on B2 (meetings made before the switch). */
  legacy?: Pick<StorageService, 'download' | 'deleteFolder'>;
}

/** The S3 client for a B2 endpoint (also used by the bucket set-up and check scripts). */
export function makeS3Client(
  o: Pick<B2Options, 'endpoint' | 'region' | 'keyId' | 'applicationKey'>,
): S3Client {
  return new S3Client({
    region: o.region ?? 'us-west-004',
    endpoint: o.endpoint,
    credentials: { accessKeyId: o.keyId ?? '', secretAccessKey: o.applicationKey ?? '' },
    // B2 does not accept the checksum headers newer SDK versions add by default
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createB2Storage(o: B2Options): StorageService {
  const client = o.client ?? makeS3Client(o);
  const Bucket = o.bucket;

  return {
    trimsRemotely: false,

    async signUpload(folder) {
      const key = `${folder}/original-${randomBytes(6).toString('hex')}`;
      const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key }), {
        expiresIn: UPLOAD_LINK_SECONDS,
      });
      return {
        provider: 'b2',
        method: 'PUT',
        uploadUrl,
        folder,
        publicId: key,
        url: `${B2_SCHEME}${key}`,
      };
    },

    async uploadAudio(path, publicId) {
      try {
        const { size } = await stat(path);
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: publicId,
            Body: createReadStream(path),
            ContentLength: size,
            ...(path.endsWith('.flac') ? { ContentType: 'audio/flac' } : {}),
          }),
        );
        return { url: `${B2_SCHEME}${publicId}`, publicId };
      } catch (err) {
        throw classify(err);
      }
    },

    trimmedWavUrl() {
      throw new Error('B2 cannot cut clips; cut the audio locally first');
    },

    // The playback link is built when a meeting is shown (it is signed and can be revoked by
    // rotating JWT_SECRET), so nothing is stored for B2 objects.
    playbackUrl() {
      return '';
    },

    /**
     * Without `seconds` this is a playback link: signed at the start of the current hour, so the same
     * address is returned for a whole hour (the browser can reuse what it already fetched instead of
     * downloading again) and still has at least five hours to run. B2 is asked to send a cache header.
     * With `seconds` the link is exact and short-lived (handing a file to another service).
     */
    async presignGet(key, seconds) {
      if (seconds !== undefined)
        return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
          expiresIn: seconds,
        });
      const hour = 3600_000;
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseCacheControl: `private, max-age=${PLAYBACK_CACHE_SECONDS}`,
        }),
        {
          expiresIn: DOWNLOAD_LINK_SECONDS,
          signingDate: new Date(Math.floor(Date.now() / hour) * hour),
        },
      );
    },

    async download(url, dest) {
      if (!isB2Url(url)) {
        if (!o.legacy)
          throw new FatalError(`Audio file is not on B2 and no other storage is set: ${url}`);
        return o.legacy.download(url, dest);
      }
      let body: unknown;
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: keyOfB2Url(url) }));
        body = res.Body;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound')
          throw new FatalError(`Audio file not found at storage (${keyOfB2Url(url)})`);
        throw classify(err);
      }
      if (!(body instanceof Readable)) throw new FatalError('Storage returned no audio data');
      await pipeline(body, createWriteStream(dest));
    },

    async deleteFolder(folder) {
      const Prefix = `${folder.replace(/\/+$/, '')}/`;
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }),
        );
        const keys = (page.Contents ?? []).flatMap((c) => (c.Key ? [{ Key: c.Key }] : []));
        if (keys.length)
          await client.send(
            new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }),
          );
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      // meetings stored before the switch live in the old storage under the same folder name
      if (o.legacy) await o.legacy.deleteFolder(folder).catch(() => undefined);
    },
  };
}
