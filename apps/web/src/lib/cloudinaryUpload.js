// Direct browser → Cloudinary upload with real progress, signed by the API for one meeting folder.
import { api } from '@/api/client';

/** Returns { meetingId, cloudName, apiKey, folder, timestamp, signature, uploadUrl }. */
export function getUploadSignature() {
  return api.uploads.sign();
}

// Direct browser upload with real progress. The server decides where the file goes and tells us how:
// `provider: "b2"` is a presigned PUT to private storage; otherwise the signed Cloudinary form POST.
export function uploadToCloudinary(file, signature, onProgress) {
  if (signature.provider === 'b2') return putToStorage(file, signature, onProgress);
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('api_key', signature.apiKey);
    formData.append('timestamp', String(signature.timestamp));
    formData.append('signature', signature.signature);
    formData.append('folder', signature.folder);

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.secure_url) resolve({ url: res.secure_url, publicId: res.public_id });
          else reject(new Error('Cloudinary returned no URL'));
        } catch {
          reject(new Error('Could not parse upload response'));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.open('POST', signature.uploadUrl);
    xhr.send(formData);
  });
}

/** A dropped connection or a busy server is worth another try; a refused or expired link is not. */
const RETRY_DELAYS_MS = [2000, 5000];
const failure = (message, retryable) => Object.assign(new Error(message), { retryable });

/**
 * Presigned PUT (private storage) with up to two more tries after a network error or a server-side error. The
 * request is the whole file, so a try starts from the beginning.
 */
async function putToStorage(file, signature, onProgress) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await putOnce(file, signature, onProgress);
    } catch (err) {
      if (!err?.retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** One presigned PUT: the file is the whole request body; progress is real. */
function putOnce(file, signature, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300)
        resolve({ url: signature.url, publicId: signature.publicId });
      else
        reject(
          failure(
            `Upload failed (${xhr.status})`,
            xhr.status >= 500 || xhr.status === 408 || xhr.status === 429,
          ),
        );
    };
    xhr.onerror = () => reject(failure('Network error during upload', true));
    xhr.onabort = () => reject(failure('Upload was interrupted', true));
    xhr.open(signature.method || 'PUT', signature.uploadUrl);
    if (file.type) xhr.setRequestHeader('Content-Type', file.type);
    xhr.send(file);
  });
}

const MAX_SIZE = 500 * 1024 * 1024; // 500 MB

export function validateAudioFile(file) {
  if (!file) return 'No file selected.';
  if (!file.type?.startsWith('audio/') && !file.type?.startsWith('video/')) {
    return 'Please select an audio or video file.';
  }
  if (file.size > MAX_SIZE) return 'File is too large (max 500 MB).';
  if (file.size < 1024) return 'This file is empty.';
  return null;
}
