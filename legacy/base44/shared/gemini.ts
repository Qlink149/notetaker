import { secrets } from "base44:runtime";
import { cloudinaryTrimUrl, cloudinaryNormalizedMp3Url } from "./cloudinary.ts";

// Gemini is genuinely multilingual — it transcribes Gujarati, Hindi and
// English (including code-switching within the same sentence) in one pass,
// where Deepgram's multilingual model doesn't cover Gujarati at all. Calls
// Google's Gemini API directly with the app's own key, so it doesn't touch
// the platform's integration credits.
//
// Chunked approach: for recordings longer than CHUNK_SEC, we build Cloudinary
// trim URLs for each segment, download the small chunk, and send it inline.
// This avoids the 524 timeouts that happened when sending the full file inline.

const MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash"];
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const CHUNK_SEC = 300; // 5 minutes — small enough to avoid 524 timeouts
const RETRYABLE = new Set([429, 503, 524, 500]);

function toBase64(buffer) {
  const arr = new Uint8Array(buffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Transcribe a single audio chunk (inline bytes). Returns utterances with
// timestamps relative to the chunk start.
async function transcribeChunk(audioBytes, mimetype, keyTerms) {
  const key = secrets.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const mime = mimetype || "audio/webm";
  const data = toBase64(audioBytes);
  let prompt =
    "You are a multilingual meeting transcription engine. Transcribe the ENTIRE audio file verbatim. " +
    "The audio may contain a mix of Gujarati, Hindi and English; code-switching within the same sentence is common. " +
    "Transcribe each language exactly as spoken, in its native script (Gujarati script for Gujarati, Devanagari for Hindi, Latin for English). " +
    "Do NOT translate, summarize or skip any speech — including low-volume or fast speech. " +
    "Break the transcript into short utterances (roughly one per sentence or speaker turn) and give each accurate start/end times in seconds. " +
    "Timestamps must cover the whole audio with no long gaps. ";
  if (keyTerms && keyTerms.length) {
    prompt += `Proper names and terms to spell correctly: ${keyTerms.join(", ")}. `;
  }
  prompt +=
    'Return ONLY a JSON object: {"utterances": [{"start": <number>, "end": <number>, "text": "..."}]}.';
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  };

  let res = null;
  let lastErr = "gemini transcription failed";
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(`${ENDPOINT(model)}?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) break;
        const errText = await res.text();
        lastErr = `gemini transcription failed (${model}): ${errText}`;
        if (!RETRYABLE.has(res.status)) break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 3000));
      } catch (e) {
        lastErr = `gemini fetch error (${model}): ${e.message}`;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (res && res.ok) break;
  }
  if (!res || !res.ok) throw new Error(lastErr);

  const json = await res.json();
  const text =
    (json?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("") || "";
  if (!text.trim()) throw new Error("No speech detected in this segment.");
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed.utterances || parsed.segments || [];
  return list
    .filter((u) => u && typeof u.text === "string" && u.text.trim())
    .map((u) => {
      const start = Number(u.start) || 0;
      const end = Number(u.end);
      return { text: u.text.trim(), start, end: isNaN(end) ? start : end };
    });
}

// Transcribe from Cloudinary, chunking by CHUNK_SEC if duration > CHUNK_SEC.
// Downloads each chunk, transcribes, adjusts timestamps, concatenates.
export async function transcribeGeminiFromCloudinary(publicId, durationSeconds, keyTerms) {
  if (!publicId) throw new Error("No Cloudinary public_id for Gemini transcription");
  const dur = durationSeconds || 0;
  const kt = keyTerms || [];

  // Single chunk if short enough or duration unknown (try full file)
  if (dur <= CHUNK_SEC || dur === 0) {
    const url = dur === 0 ? cloudinaryNormalizedMp3Url(publicId) : cloudinaryTrimUrl(publicId, 0, dur);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not fetch audio for Gemini: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const mime = r.headers.get("content-type") || "audio/mp3";
    return transcribeChunk(bytes, mime, kt);
  }

  // Multi-chunk: sequential to avoid rate limits
  const allUtterances = [];
  for (let offset = 0; offset < dur; offset += CHUNK_SEC) {
    const end = Math.min(offset + CHUNK_SEC, dur);
    const url = cloudinaryTrimUrl(publicId, offset, end);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not fetch Gemini chunk at ${offset}s: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const mime = r.headers.get("content-type") || "audio/mp3";
    const chunkUtts = await transcribeChunk(bytes, mime, kt);
    for (const u of chunkUtts) {
      allUtterances.push({
        text: u.text,
        start: u.start + offset,
        end: u.end + offset,
      });
    }
  }
  return allUtterances;
}

// Keep the old export for backward compat (used by the benchmark)
export async function transcribeWithGemini(audioBytes, mimetype) {
  return transcribeChunk(audioBytes, mimetype, []);
}