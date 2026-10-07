import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { v2 as cloudinary } from 'cloudinary';
import { requireEnv } from '../../config/env.js';
import { FatalError, classify, errorForStatus } from '../../pipeline/errors.js';

let configured = false;
function cld(): typeof cloudinary {
  if (!configured) {
    cloudinary.config({
      cloud_name: requireEnv('CLOUDINARY_CLOUD_NAME'),
      api_key: requireEnv('CLOUDINARY_API_KEY'),
      api_secret: requireEnv('CLOUDINARY_API_SECRET'),
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

/** Folder for everything belonging to one meeting (never a shared folder). */
export const meetingFolder = (workspaceSlug: string, meetingId: string): string =>
  `workspaces/${workspaceSlug}/meetings/${meetingId}`;

export interface StorageService {
  signUpload(folder: string): {
    cloudName: string;
    apiKey: string;
    folder: string;
    timestamp: number;
    signature: string;
    uploadUrl: string;
  };
  /** Upload a local audio file as a `video` asset so Cloudinary can transcode it. */
  uploadAudio(path: string, publicId: string): Promise<{ url: string; publicId: string }>;
  /** WAV derivative of [startSec, endSec] of an audio asset (voiceprint clips). */
  trimmedWavUrl(publicId: string, startSec: number, endSec: number): string;
  /** 64 kbps MP3 derivative of the original, for playback only. */
  playbackUrl(originalPublicId: string): string;
  download(url: string, dest: string): Promise<void>;
  deleteFolder(folder: string): Promise<void>;
}

export const cloudinaryStorage: StorageService = {
  signUpload(folder) {
    const c = cld();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = c.utils.api_sign_request(
      { folder, timestamp },
      requireEnv('CLOUDINARY_API_SECRET'),
    );
    const cloudName = requireEnv('CLOUDINARY_CLOUD_NAME');
    return {
      cloudName,
      apiKey: requireEnv('CLOUDINARY_API_KEY'),
      folder,
      timestamp,
      signature,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    };
  },

  async uploadAudio(path, publicId) {
    try {
      const res = await cld().uploader.upload(path, {
        resource_type: 'video',
        public_id: publicId,
        overwrite: true,
      });
      return { url: res.secure_url, publicId: res.public_id };
    } catch (err) {
      throw classify(err);
    }
  },

  trimmedWavUrl(publicId, startSec, endSec) {
    const so = Math.max(0, Math.floor(startSec * 1000) / 1000);
    const eo = Math.max(so + 0.1, Math.floor(endSec * 1000) / 1000);
    return cld().url(publicId, {
      resource_type: 'video',
      format: 'wav',
      transformation: [{ start_offset: so, end_offset: eo }],
    });
  },

  playbackUrl(originalPublicId) {
    return cld().url(originalPublicId, {
      resource_type: 'video',
      format: 'mp3',
      transformation: [{ audio_codec: 'mp3', bit_rate: '64k' }],
    });
  },

  async download(url, dest) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    } catch (err) {
      throw classify(err);
    }
    if (res.status === 404) throw new FatalError(`Audio file not found at storage (${res.status})`);
    if (!res.ok || !res.body)
      throw errorForStatus('storage', res.status, await res.text().catch(() => ''));
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(dest));
  },

  async deleteFolder(folder) {
    const c = cld();
    for (const resource_type of ['video', 'raw', 'image'] as const) {
      await c.api
        .delete_resources_by_prefix(`${folder}/`, { resource_type })
        .catch(() => undefined);
    }
    await c.api.delete_folder(folder).catch(() => undefined);
  },
};
