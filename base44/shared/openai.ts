import { secrets } from "base44:runtime";
import { cloudinaryTrimUrl, cloudinaryNormalizedMp3Url } from "./cloudinary.ts";

// OpenAI transcription engine — uses gpt-4o-transcribe (multilingual, handles
// Gujarati/Hindi/English with auto-detect). Calls OpenAI's API directly with
// the app's own key. Uses Cloudinary chunking for long files (>25MB API limit).
//
// Same word-timestamp output shape as Deepgram/Gemini so the existing
// alignment stage works unchanged.

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
// whisper-1 is first because it's the only OpenAI model that supports
// verbose_json (word-level timestamps needed for speaker alignment).
// gpt-4o-transcribe only supports json/text (no timestamps).
const MODELS = ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"];
const CHUNK_SEC = 300; // 5-min chunks — each ~2.5MB, transcribes in ~30s, avoids 5-min function timeout
const MAX_FILE_BYTES = 24 * 1024 * 1024; // 24MB API safety margin

// Transcribe a single audio chunk (Blob). Returns utterances with word timing.
async function transcribeChunk(blob, lang) {
  const key = secrets.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY not set");

  let lastErr = "openai transcription failed";
  for (const model of MODELS) {
    try {
      const formData = new FormData();
      formData.append("file", blob, "chunk.mp3");
      formData.append("model", model);
      formData.append("response_format", "verbose_json");
      formData.append("timestamp_granularities[]", "word");
      formData.append("timestamp_granularities[]", "segment");
      if (lang && lang !== "auto") formData.append("language", lang);

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        const segments = data.segments || [];
        return segments.map((s) => ({
          text: (s.text || "").trim(),
          start: s.start,
          end: s.end,
          words: (s.words || []).map((w) => ({
            word: w.word,
            start: w.start,
            end: w.end,
          })),
        }));
      }
      const errText = await res.text();
      lastErr = `openai ${model} failed: ${errText}`;
      // Only break on auth errors (same key won't work on any model).
      // On 400 (e.g. model doesn't support verbose_json), try the next model.
      if (res.status === 401 || res.status === 403) break;
    } catch (e) {
      lastErr = `openai ${model} error: ${e.message}`;
    }
  }
  throw new Error(lastErr);
}

export const OPENAI_CHUNK_SEC = CHUNK_SEC;

// Transcribe a single chunk (startSec–endSec) from Cloudinary. Returns
// utterances with timestamps adjusted to the full-file timeline.
export async function transcribeOpenAIChunk(publicId, startSec, endSec, lang) {
  const url = cloudinaryTrimUrl(publicId, startSec, endSec);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch OpenAI chunk at ${startSec}s: ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const blob = new Blob([bytes], { type: "audio/mp3" });
  const chunkUtts = await transcribeChunk(blob, lang);
  return chunkUtts.map((u) => ({
    text: u.text,
    start: u.start + startSec,
    end: u.end + startSec,
    words: (u.words || []).map((w) => ({
      word: w.word,
      start: w.start + startSec,
      end: w.end + startSec,
    })),
  }));
}

// Transcribe the full file in one request (used when duration is unknown).
export async function transcribeOpenAIFull(publicId, lang) {
  const url = cloudinaryNormalizedMp3Url(publicId);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch audio for OpenAI: ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const blob = new Blob([bytes], { type: "audio/mp3" });
  return transcribeChunk(blob, lang);
}