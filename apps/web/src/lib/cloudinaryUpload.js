// Direct Cloudinary upload with real progress — no bytes through a Base44 function.
export async function getUploadSignature() {
  const { base44 } = await import("@/api/base44Client");
  const res = await base44.functions.invoke("getUploadSignature", {});
  return res?.data || res;
}

export function uploadToCloudinary(file, signature, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("api_key", signature.apiKey);
    formData.append("timestamp", String(signature.timestamp));
    formData.append("signature", signature.signature);
    formData.append("folder", signature.folder);

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
          if (res.secure_url) {
            resolve({ url: res.secure_url, publicId: res.public_id, duration: res.duration });
          } else {
            reject(new Error("Cloudinary returned no URL"));
          }
        } catch (e) {
          reject(new Error("Could not parse upload response"));
        }
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open("POST", signature.uploadUrl);
    xhr.send(formData);
  });
}

// Read audio/video duration via a media element. Returns seconds or null.
export function readMediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type?.startsWith("video/") ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const d = el.duration;
      URL.revokeObjectURL(url);
      resolve(isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    el.src = url;
  });
}

const MAX_SIZE = 500 * 1024 * 1024; // 500 MB

export function validateAudioFile(file) {
  if (!file) return "No file selected.";
  if (!file.type?.startsWith("audio/") && !file.type?.startsWith("video/")) {
    return "Please select an audio or video file.";
  }
  if (file.size > MAX_SIZE) {
    return "File is too large (max 500 MB).";
  }
  return null;
}