import { secrets } from "base44:runtime";

const BASE = "https://api.pyannote.ai/v1";

export function pyannoteHeaders() {
  const key = secrets.get("PYANNOTEAI_API_KEY");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export async function pollPyannoteJob(jobId, maxAttempts = 50, intervalMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${BASE}/jobs/${jobId}`, { headers: pyannoteHeaders() });
    if (!res.ok) throw new Error(`pyannote job poll failed: ${res.status}`);
    const job = await res.json();
    if (job.status === "succeeded" || job.status === "done") return job.output;
    if (job.status === "failed")
      throw new Error(`pyannote job failed: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("pyannote job timed out");
}

// Non-blocking single check of a pyannote job — used by the staged pipeline so
// each invocation checks once and returns, instead of blocking for up to 150s.
export async function checkPyannoteJob(jobId) {
  const res = await fetch(`${BASE}/jobs/${jobId}`, { headers: pyannoteHeaders() });
  if (!res.ok) throw new Error(`pyannote job check failed: ${res.status}`);
  const job = await res.json();
  if (job.status === "succeeded" || job.status === "done")
    return { done: true, output: job.output };
  if (job.status === "failed")
    throw new Error(`pyannote job failed: ${JSON.stringify(job)}`);
  return { done: false, output: null };
}

// Upload raw audio bytes to pyannote's own media storage; returns a media:// URL
// that pyannote endpoints (diarize, identify, voiceprint) accept directly.
export async function uploadToPyannoteMedia(bytes, objectKey) {
  const createRes = await fetch(`${BASE}/media/input`, {
    method: "POST",
    headers: pyannoteHeaders(),
    body: JSON.stringify({ url: `media://${objectKey}` }),
  });
  if (!createRes.ok) throw new Error(`pyannote media create failed: ${await createRes.text()}`);
  const created = await createRes.json();
  const presignedUrl = created.url;
  if (!presignedUrl) throw new Error("pyannote media: no presigned url returned");
  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!putRes.ok) throw new Error(`pyannote media put failed: ${await putRes.text()}`);
  return `media://${objectKey}`;
}