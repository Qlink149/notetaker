import { secrets } from "base44:runtime";
import { pyannoteHeaders, checkPyannoteJob, pollPyannoteJob } from "./pyannote.ts";
import { callClaude, parseJsonLoose } from "./anthropic.ts";

// ============================================================================
// Shared pipeline logic — used by processMeeting (staged) and the Phase 5
// benchmark. Each function does ONE bounded unit of work.
// ============================================================================

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

// pyannote's identify endpoint ignores `matching.threshold` and always fills
// `match` with the best-scoring voiceprint for every segment — even when the
// similarity is degenerate. We gate on per-voiceprint confidence ourselves.
// Grounded in measured data: real enrolled speakers score 83-89, unenrolled 16-36.
export const MATCH_CONFIDENCE_MIN = 50;

// Submit a pyannote identify job (does NOT block — returns the jobId).
export async function submitIdentify(audioUrl, voiceprints) {
  const valid = voiceprints.filter((v) => v.voiceprint_id).slice(0, 10); // max 10
  if (!valid.length) return null;
  const res = await fetch("https://api.pyannote.ai/v1/identify", {
    method: "POST",
    headers: pyannoteHeaders(),
    body: JSON.stringify({
      url: audioUrl,
      voiceprints: valid.map((v) => ({ label: v.name, voiceprint: v.voiceprint_id })),
      matching: { threshold: MATCH_CONFIDENCE_MIN, exclusive: true },
      confidence: true,
      turnLevelConfidence: true,
    }),
  });
  if (!res.ok) throw new Error(`pyannote identify submit failed: ${await res.text()}`);
  const created = await res.json();
  return created.jobId;
}

// Submit a pyannote diarize job (does NOT block — returns the jobId).
export async function submitDiarize(audioUrl) {
  const res = await fetch("https://api.pyannote.ai/v1/diarize", {
    method: "POST",
    headers: pyannoteHeaders(),
    body: JSON.stringify({ url: audioUrl }),
  });
  if (!res.ok) throw new Error(`pyannote diarize submit failed: ${await res.text()}`);
  const created = await res.json();
  return created.jobId;
}

// Parse the pyannote identify output into identification segments.
export function parseIdentifyOutput(output) {
  return (output && output.identification) || [];
}

// Parse the pyannote diarize output into diarization segments.
export function parseDiarizeOutput(output) {
  const segs = (output && (output.diarization || output.segments)) || [];
  return segs.map((s) => ({
    start: s.start,
    end: s.end,
    speaker: s.speaker,
    diarizationSpeaker: s.speaker,
    match: null,
  }));
}

// Resolve diarization speakers to names via duration-weighted confidence scores.
export function resolveSpeakers(identification) {
  const wSum = {};
  const durSum = {};
  for (const seg of identification) {
    const key = seg.diarizationSpeaker || seg.speaker;
    const dur = Math.max(0.01, seg.end - seg.start);
    const c = seg.confidence || {};
    for (const [vp, score] of Object.entries(c)) {
      const k = `${key}||${vp}`;
      wSum[k] = (wSum[k] || 0) + score * dur;
      durSum[k] = (durSum[k] || 0) + dur;
    }
  }
  const speakerMap = {};
  let unknownIdx = 0;
  const speakerKeys = [...new Set(identification.map((s) => s.diarizationSpeaker || s.speaker))];
  for (const key of speakerKeys) {
    const scores = {};
    for (const [k, total] of Object.entries(wSum)) {
      const [sp, vp] = k.split("||");
      if (sp === key) scores[vp] = total / (durSum[k] || 1);
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= MATCH_CONFIDENCE_MIN) {
      speakerMap[key] = best[0];
    } else {
      unknownIdx += 1;
      speakerMap[key] = `Unknown ${unknownIdx}`;
    }
  }
  return speakerMap;
}

// Build transcript lines by assigning each utterance to its dominant speaker.
// Uses word-level timing to find which diarization segment covers the most
// word-duration within the utterance (falls back to best temporal overlap when
// word timing is unavailable). Then merges consecutive utterances from the same
// speaker. This keeps utterances intact — no mid-sentence speaker fragmentation.
export function buildTranscript(utterances, identification, speakerMap) {
  if (!utterances.length) return [];
  if (!identification.length) {
    return utterances.map((u) => ({
      speaker_name: "Unknown",
      text: u.text,
      text_native: u.text,
      start_time: u.start,
      end_time: u.end,
    }));
  }

  const segs = [...identification].sort((a, b) => a.start - b.start);

  // Assign each utterance to its dominant speaker
  const assigned = utterances.map((u) => {
    let dominantKey = null;

    if (u.words && u.words.length) {
      // Word-level: accumulate duration per diarization speaker key
      const speakerDuration = {};
      for (const w of u.words) {
        const mid = (w.start + w.end) / 2;
        let seg = null;
        for (const s of segs) {
          if (mid >= s.start && mid <= s.end) { seg = s; break; }
        }
        if (!seg) {
          let bestDist = Infinity;
          for (const s of segs) {
            const d = mid < s.start ? s.start - mid : mid - s.end;
            if (d < bestDist) { bestDist = d; seg = s; }
          }
        }
        if (seg) {
          const key = seg.diarizationSpeaker || seg.speaker;
          const wDur = Math.max(0.01, w.end - w.start);
          speakerDuration[key] = (speakerDuration[key] || 0) + wDur;
        }
      }
      const best = Object.entries(speakerDuration).sort((a, b) => b[1] - a[1])[0];
      if (best) dominantKey = best[0];
    }

    if (!dominantKey) {
      // Fallback: best temporal overlap between utterance and diarization segment
      let bestSeg = null;
      let bestOverlap = 0;
      for (const seg of segs) {
        const inter = Math.min(seg.end, u.end) - Math.max(seg.start, u.start);
        if (inter > bestOverlap) { bestOverlap = inter; bestSeg = seg; }
      }
      if (bestSeg) dominantKey = bestSeg.diarizationSpeaker || bestSeg.speaker;
    }

    const name = dominantKey ? (speakerMap[dominantKey] || "Unknown") : "Unknown";
    return {
      speaker_name: name,
      text: u.text,
      text_native: u.text,
      start_time: u.start,
      end_time: u.end,
    };
  });

  // Merge consecutive utterances from the same speaker
  const lines = [];
  for (const u of assigned) {
    const last = lines[lines.length - 1];
    if (last && last.speaker_name === u.speaker_name) {
      last.text += " " + u.text;
      last.text_native = (last.text_native || last.text) + " " + (u.text_native || u.text);
      last.end_time = u.end_time;
    } else {
      lines.push({ ...u });
    }
  }
  return lines;
}

// Transcribe with Deepgram Nova-3. Uses URL mode with the normalized mp3 URL.
// Returns utterances with word-level timing.
export async function transcribeDeepgram(audioUrl, language, keyTerms) {
  const params = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
    uttwords: "true", // word-level timestamps within each utterance
  });
  if (language && language !== "auto") {
    params.set("language", language);
  } else {
    params.set("detect_language", "true");
  }
  // key_terms → Deepgram keyterm params (one per term)
  if (keyTerms && keyTerms.length) {
    for (const t of keyTerms.slice(0, 20)) {
      params.append("keyterm", t);
    }
  }
  const res = await fetch(`${DEEPGRAM_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${secrets.get("DEEPGRAM_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: audioUrl }),
  });
  if (!res.ok) throw new Error(`deepgram failed: ${await res.text()}`);
  const data = await res.json();
  const utterances = data?.results?.utterances || [];
  const metaDuration = data?.metadata?.duration || 0;

  // Coverage check: Deepgram sometimes returns a partial utterances array
  // (transient API issue — e.g. 73 utterances covering 8% of a 34-min file).
  // If coverage is too low, fall back to channel words which always cover
  // the full audio.
  const uttDuration = utterances.reduce((s, u) => s + (u.end - u.start), 0);
  const coverage = metaDuration > 0 ? uttDuration / metaDuration : 1;

  if (utterances.length > 0 && coverage > 0.3) {
    return utterances.map((u) => ({
      text: u.transcript || "",
      start: u.start,
      end: u.end,
      words: (u.words || []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
    }));
  }

  // Fallback: build utterances from channel words (full coverage, less formatting)
  const allWords = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  return buildUtterancesFromWords(allWords);
}

// Group word-level timestamps into utterances by detecting pauses (>0.5s gap).
// Fallback when Deepgram's utterances array has poor coverage.
function buildUtterancesFromWords(allWords) {
  if (!allWords.length) return [];
  const PAUSE_THRESHOLD = 0.5;
  const result = [];
  let current = null;
  for (const w of allWords) {
    if (!current || (w.start - current.end) > PAUSE_THRESHOLD) {
      if (current) result.push(current);
      current = {
        text: w.word,
        start: w.start,
        end: w.end,
        words: [{ word: w.word, start: w.start, end: w.end }],
      };
    } else {
      current.text += " " + w.word;
      current.end = w.end;
      current.words.push({ word: w.word, start: w.start, end: w.end });
    }
  }
  if (current) result.push(current);
  return result;
}

// Detect if any line contains Indic script (Devanagari or Gujarati).
export function hasIndicScript(lines) {
  return lines.some((l) => /[\u0900-\u097F\u0A80-\u0AFF]/.test(l.text || ""));
}

// Batched transliteration: only lines with Indic script, 40 per Claude call.
// Returns an array of romanized strings aligned to the input (non-Indic lines
// pass through unchanged). Retries a bad batch once, then keeps native text.
export async function transliterate(lines) {
  if (!lines.length) return lines.map((l) => l.text);
  if (!hasIndicScript(lines)) return lines.map((l) => l.text);

  // Index lines that need transliteration
  const needIdx = [];
  const needText = [];
  lines.forEach((l, i) => {
    if (/[\u0900-\u097F\u0A80-\u0AFF]/.test(l.text || "")) {
      needIdx.push(i);
      needText.push(l.text);
    }
  });

  const result = lines.map((l) => l.text); // default: keep original
  const BATCH = 40;
  for (let b = 0; b < needText.length; b += BATCH) {
    const batch = needText.slice(b, b + BATCH);
    const batchIdx = needIdx.slice(b, b + BATCH);
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const text = await callClaude(
          "You are a transliteration engine. Input is a JSON array of meeting transcript lines. Some contain Gujarati (Gujarati script) or Hindi (Devanagari script), often mixed with English. Transliterate ALL Gujarati-script and Devanagari-script words into the Latin/English alphabet (romanization), preserving pronunciation. Keep English words EXACTLY as spoken. Do NOT translate any language to another — only transliterate scripts to Latin. Preserve fillers (um, uh), false starts, self-corrections, repeated words, and incomplete sentences EXACTLY. PRESERVE all punctuation and capitalization. Convert Devanagari danda (।) to a period. Keep proper nouns capitalized. Return ONLY a JSON object: {\"lines\": [\"...\", \"...\"]} with the SAME length and order as the input. Input lines: " +
            JSON.stringify(batch),
          { maxTokens: 8192 }
        );
        const parsed = parseJsonLoose(text);
        const out = parsed && parsed.lines;
        if (Array.isArray(out) && out.length === batch.length) {
          batchIdx.forEach((origIdx, j) => { result[origIdx] = out[j]; });
          done = true;
        }
      } catch (e) {
        // retry once, then keep native text for this batch
      }
    }
  }
  return result;
}

// Generate summary + action items. 8000 max tokens. If transcript is very long
// (>60k chars), summarize in chunks then merge. Never returns a silent empty
// summary — on failure returns summary_status: "failed".
export async function generateSummary(transcriptText) {
  const MAX_CHARS = 60000;
  try {
    let textToSummarize = transcriptText;
    if (transcriptText.length > MAX_CHARS) {
      // Chunk: summarize each chunk, then merge the chunk summaries
      const chunks = [];
      const lines = transcriptText.split("\n");
      let cur = [];
      let curLen = 0;
      for (const line of lines) {
        if (curLen + line.length > MAX_CHARS && cur.length) {
          chunks.push(cur.join("\n"));
          cur = [];
          curLen = 0;
        }
        cur.push(line);
        curLen += line.length + 1;
      }
      if (cur.length) chunks.push(cur.join("\n"));
      const chunkSummaries = [];
      for (const chunk of chunks) {
        const s = await _summarizeChunk(chunk);
        chunkSummaries.push(s);
      }
      textToSummarize = "Summaries of meeting segments:\n\n" + chunkSummaries.map((s, i) => `Segment ${i + 1}:\n${s}`).join("\n\n");
    }

    const text = await callClaude(
      "You are an expert meeting analyst. Below is a transcript of a meeting with labeled speakers.\n\n" +
        "The transcript may contain romanized Hindi or Gujarati (written in Latin script). The summary must be in English. Preserve names, numbers, and terms exactly.\n\n" +
        "Write a DETAILED, SMART, well-structured summary in Markdown. Be specific and substantive — reference actual topics, names, numbers, proposals, and conclusions from the conversation.\n\n" +
        "Structure the summary with these Markdown sections:\n\n" +
        "## Overview\n2-3 sentences on the meeting's purpose, who was involved, and the overall context.\n\n" +
        "## Key Topics Discussed\nA bulleted list of the main topics. For each, 1-3 sentences of specifics.\n\n" +
        "## Decisions Made\nA bulleted list of concrete decisions. If none were made, say \"No explicit decisions were made.\"\n\n" +
        "## Important Insights & Points\nNotable points, risks, concerns, or strategic observations.\n\n" +
        "## Open Questions / Follow-ups\nAnything unresolved or flagged for further discussion.\n\n" +
        "Then, separately, produce ACTION_ITEMS: a thorough, actionable to-do list. Extract EVERY task, follow-up, commitment, or next step mentioned. For each:\n" +
        "   - Write it as a clear imperative phrase starting with a verb.\n" +
        "   - Attribute it to the responsible speaker using the EXACT speaker name; if unclear, use \"Unknown\".\n" +
        "   - Include any deadline, owner, dependency, or context stated.\n" +
        "   - Be specific enough to act on. Deduplicate near-identical items.\n\n" +
        "Return ONLY JSON: {\"summary\": \"...markdown...\", \"action_items\": [{\"speaker_name\": \"...\", \"text\": \"...\"}]}.\n\n" +
        "Transcript:\n" +
        textToSummarize,
      { maxTokens: 8000, model: "claude-haiku-4-5-20251001" }
    );
    const parsed = parseJsonLoose(text);
    const summary = (parsed && parsed.summary) || "";
    const action_items = parsed && Array.isArray(parsed.action_items) ? parsed.action_items : [];
    if (!summary) return { summary: "", action_items: [], summary_status: "failed" };
    return { summary, action_items, summary_status: "completed" };
  } catch (e) {
    return { summary: "", action_items: [], summary_status: "failed" };
  }
}

async function _summarizeChunk(chunk) {
  try {
    const text = await callClaude(
      "Summarize this meeting transcript segment in 3-5 sentences of Markdown. Be specific about topics, names, and numbers. Transcript:\n" + chunk,
      { maxTokens: 1024, model: "claude-haiku-4-5-20251001" }
    );
    return text || "";
  } catch { return ""; }
}