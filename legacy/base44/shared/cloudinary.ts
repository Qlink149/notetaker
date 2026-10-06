import { secrets } from "base44:runtime";

async function sha1Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Uploads an audio Blob to Cloudinary using a signed (api_key + secret) upload.
// Replaces the platform's UploadPublicFile, which is blocked when the workspace
// is out of integration credits. Returns the public https URL of the stored file.
export async function uploadAudioToCloudinary(
  file: Blob,
  filename = "audio",
  mimetype = "audio/webm"
): Promise<string> {
  const cloudName = secrets.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = secrets.get("CLOUDINARY_API_KEY");
  const apiSecret = secrets.get("CLOUDINARY_API_SECRET");
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in app secrets."
    );
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sha1Hex(`timestamp=${timestamp}${apiSecret}`);
  const form = new FormData();
  form.append("file", file, filename);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("resource_type", "auto");
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!res.ok || !json.secure_url) {
    throw new Error(`Cloudinary upload failed: ${json?.error?.message || res.status}`);
  }
  return { url: json.secure_url as string, publicId: json.public_id as string };
}

// Cloudinary on-the-fly transcode to WAV. pyannote reliably decodes WAV, whereas
// browser-recorded webm/opus often fails voiceprint with "no speech detected".
export function cloudinaryWavUrl(publicId: string): string {
  const cloudName = secrets.get("CLOUDINARY_CLOUD_NAME");
  return `https://res.cloudinary.com/${cloudName}/video/upload/f_wav/${publicId}.wav`;
}

// Normalized MP3 URL at 64 kbps — the canonical audio URL for all providers
// and the player. Fixes iPhone mp4-as-webm, video uploads, and unseekable webm
// (the f_mp3 transcode adds proper duration headers so click-to-seek works).
export function cloudinaryNormalizedMp3Url(publicId: string): string {
  const cloudName = secrets.get("CLOUDINARY_CLOUD_NAME");
  return `https://res.cloudinary.com/${cloudName}/video/upload/f_mp3,br_64k/${publicId}.mp3`;
}

// Trimmed audio clip from a Cloudinary public_id: start/end in seconds, MP3 64k.
// Used by the OpenAI engine (per-clip transcription) and enrollment (voiceprint
// clip extraction without downloading the full meeting in the browser).
export function cloudinaryTrimUrl(publicId: string, startSec: number, endSec: number): string {
  const cloudName = secrets.get("CLOUDINARY_CLOUD_NAME");
  const s = Math.max(0, Math.floor(startSec * 1000) / 1000);
  const e = Math.max(s + 0.1, Math.floor(endSec * 1000) / 1000);
  return `https://res.cloudinary.com/${cloudName}/video/upload/so_${s},eo_${e},f_mp3,br_64k/${publicId}.mp3`;
}

// Trimmed WAV clip for pyannote voiceprint enrollment — start/end in seconds.
export function cloudinaryTrimWavUrl(publicId: string, startSec: number, endSec: number): string {
  const cloudName = secrets.get("CLOUDINARY_CLOUD_NAME");
  const s = Math.max(0, Math.floor(startSec * 1000) / 1000);
  const e = Math.max(s + 0.1, Math.floor(endSec * 1000) / 1000);
  return `https://res.cloudinary.com/${cloudName}/video/upload/so_${s},eo_${e},f_wav/${publicId}.wav`;
}

// Parse a Cloudinary public_id from a secure_url, or return null.
export function publicIdFromCloudinaryUrl(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/\/(?:v\d+\/)?([^/.]+)\.[a-z0-9]+$/i);
  return m ? m[1] : null;
}