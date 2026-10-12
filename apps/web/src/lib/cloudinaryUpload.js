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

/** Presigned PUT (private storage): the file is the whole request body; progress is real. */
function putToStorage(file, signature, onProgress) {
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
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
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
