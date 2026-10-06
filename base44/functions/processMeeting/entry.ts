import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { secrets } from "base44:runtime";
import {
  submitIdentify,
  submitDiarize,
  parseIdentifyOutput,
  parseDiarizeOutput,
  resolveSpeakers,
  buildTranscript,
  transcribeDeepgram,
  generateSummary,
} from "../../shared/pipeline.ts";
import { callClaude, parseJsonLoose } from "../../shared/anthropic.ts";
import { checkPyannoteJob } from "../../shared/pyannote.ts";
import { cloudinaryNormalizedMp3Url, publicIdFromCloudinaryUrl } from "../../shared/cloudinary.ts";
import { transcribeGeminiFromCloudinary } from "../../shared/gemini.ts";
import { transcribeOpenAIChunk, transcribeOpenAIFull, OPENAI_CHUNK_SEC } from "../../shared/openai.ts";
import { routeEngine } from "../../shared/routing.ts";

// Staged, resumable meeting processor. Each invocation does ONE bounded unit
// of work (transcribe + submit pyannote, check pyannote, align, romanize, or
// summarize), saves intermediate results on the Meeting record, and returns.
// MeetingDetail polls every 4s and re-invokes to advance to the next stage.
// Must be idempotent and resumable from any stage.

const LOCK_SECONDS = 20; // skip if another run touched this stage < 20s ago
const LOCK_SECONDS_SUMMARIZING = 120; // Claude summarization can take 30-60s

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));
    const meetingId = body.meeting_id;
    if (!meetingId) return Response.json({ error: "meeting_id required" }, { status: 400 });

    const meeting = await base44.entities.Meeting.get(meetingId);
    if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });

    const stage = meeting.stage || "uploaded";
    const now = Date.now();
    const updatedMs = meeting.updated_date ? new Date(meeting.updated_date).getTime() : 0;

    // Terminal stages — skip immediately, WITHOUT acquiring the lock.
    // This prevents polling from overwriting stage_detail back to "processing"
    // after the pipeline has already completed.
    if (stage === "completed" || stage === "failed") {
      return Response.json({ skipped: true, stage, reason: "terminal" });
    }

    // Lock: skip if another run is actively processing this stage.
    // The transcribing stage (Deepgram path) also uses the lock — it sets
    // stage_detail to "processing" before calling Deepgram. The OpenAI chunked
    // path uses numeric stage_detail (chunk offset), so it's never "processing".
    // Summarizing calls Claude (30-60s), so it gets a longer lock window.
    const lockSecs = (stage === "summarizing" || stage === "romanizing") ? LOCK_SECONDS_SUMMARIZING : LOCK_SECONDS;
    if (
      meeting.stage_detail === "processing" &&
      now - updatedMs < lockSecs * 1000
    ) {
      return Response.json({ skipped: true, stage, reason: "locked" });
    }

    // Acquire the lock (except for transcribing, which manages its own state
    // — the Deepgram path acquires it inside doTranscribingStage, and the
    // OpenAI path uses stage_detail for chunk offsets).
    // Romanizing DOES use the lock to prevent concurrent invocations from
    // overwriting each other's romanized transcript, but this is safe now:
    // progress is computed from the transcript itself (which lines still have
    // Indic `text`), NOT from stage_detail — so a timeout leaving
    // stage_detail="processing" causes no progress loss on retry.
    if (stage !== "transcribing") {
      await base44.entities.Meeting.update(meetingId, { stage_detail: "processing" });
    }

    try {
      switch (stage) {
        case "uploaded":
          return await doUploadedStage(base44, meeting, body);
        case "transcribing":
          return await doTranscribingStage(base44, meeting);
        case "diarizing":
          return await doDiarizingStage(base44, meeting);
        case "aligning":
          return await doAligningStage(base44, meeting);
        case "romanizing":
          return await doRomanizingStage(base44, meeting);
        case "summarizing":
          return await doSummarizingStage(base44, meeting);
        default:
          return await doUploadedStage(base44, meeting, body);
      }
    } catch (err) {
      const msg = err.message || String(err);
      // Transient network/timeout errors: DON'T fail the meeting — just clear
      // the lock so the next polling invocation retries the same stage.
      // This prevents a momentary network blip from permanently failing a
      // 34-minute recording that would otherwise process fine on retry.
      const isTransient = /fetch|network|timeout|524|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket|aborted/i.test(msg);
      if (isTransient) {
        await base44.entities.Meeting.update(meetingId, {
          stage_detail: null,
          error_message: "",
        });
        return Response.json({ error: msg, transient: true, retrying: true }, { status: 500 });
      }
      await base44.entities.Meeting.update(meetingId, {
        status: "failed",
        stage: "failed",
        stage_detail: null,
        error_message: humanizeError(err),
      });
      return Response.json({ error: msg }, { status: 500 });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

function humanizeError(err) {
  const msg = err.message || String(err);
  if (/no speech detected/i.test(msg)) return "No speech detected in the recording.";
  if (/fetch|network|timeout|524/i.test(msg)) return "Could not reach the audio file or the transcription service timed out. Try again.";
  if (/quota|rate limit|429/i.test(msg)) return "A provider quota or rate limit was hit. Try again in a few minutes.";
  if (/unsupported|format|decode/i.test(msg)) return "The audio format is not supported. Try uploading a different file.";
  return msg;
}

async function advanceStage(base44, meeting, nextStage, extra = {}) {
  await base44.entities.Meeting.update(meeting.id, {
    stage: nextStage,
    stage_detail: null,
    ...extra,
  });
  return Response.json({ status: "advanced", stage: nextStage });
}

// Helper: find enrolled speakers and submit a pyannote job (identify or diarize).
// Used by doUploadedStage (initial submission) and doDiarizingStage (safety net
// re-submission if the job ID was lost due to a race condition).
async function submitPyannoteJob(base44, audioUrl, expectedSpeakerIds) {
  const allSpeakers = await base44.entities.Speaker.list();
  let speakersForIdentify = allSpeakers.filter((s) => s.voiceprint_id);
  if (expectedSpeakerIds && expectedSpeakerIds.length) {
    const expected = new Set(expectedSpeakerIds);
    speakersForIdentify = speakersForIdentify.filter((s) => expected.has(s.id));
  }
  if (speakersForIdentify.length) {
    const jobId = await submitIdentify(audioUrl, speakersForIdentify);
    return { jobId, mode: "identify" };
  }
  const jobId = await submitDiarize(audioUrl);
  return { jobId, mode: "diarize" };
}

// Stage 1: Submit pyannote job only (fast). Transcription is done in the
// next stage (transcribing) so it can be chunked and resumable across
// multiple invocations — avoids the 5-minute function timeout on long files.
async function doUploadedStage(base44, meeting, body) {
  let publicId = meeting.cloudinary_public_id;
  if (!publicId && meeting.audio_file_url) {
    publicId = publicIdFromCloudinaryUrl(meeting.audio_file_url);
  }
  const audioUrl =
    publicId
      ? cloudinaryNormalizedMp3Url(publicId)
      : meeting.audio_file_url || "";
  if (!audioUrl || !/^https?:\/\//.test(audioUrl)) {
    throw new Error("No audio available for transcription. Re-upload the recording.");
  }

  const route = routeEngine(meeting.language_mode);
  const engine = route?.engine || "openai";

  // Submit pyannote job (identify if voiceprints exist, otherwise diarize).
  const pyannoteResult = await submitPyannoteJob(
    base44, audioUrl, meeting.expected_speaker_ids
  );

  // Save pyannote job info + audio metadata, advance to transcribing.
  // stage_detail = "0" = starting offset for chunked transcription.
  await base44.entities.Meeting.update(meeting.id, {
    stage: "transcribing",
    stage_detail: "0",
    audio_file_url: audioUrl,
    cloudinary_public_id: publicId || meeting.cloudinary_public_id || "",
    engine,
    pyannote_job_id: pyannoteResult.jobId,
    pyannote_mode: pyannoteResult.mode,
    raw_utterances: [],
  });
  return Response.json({ status: "advanced", stage: "transcribing" });
}

// Stage 1b: Transcription. Deepgram Nova-3 transcribes the full file in a
// single URL-based request — reliable word-level timestamps (no whisper-1
// hallucination), native Hindi-English code-switching, and no chunking needed.
// Falls back to chunked OpenAI if engine is explicitly set to "openai".
async function doTranscribingStage(base44, meeting) {
  const engine = meeting.engine || "deepgram";

  if (engine === "openai") {
    return await doTranscribingOpenAI(base44, meeting);
  }

  // Deepgram path: re-fetch the meeting to get the latest stage_detail,
  // then acquire the lock. This narrows the TOCTOU race window where two
  // concurrent invocations both see stage_detail != "processing" and both
  // call Deepgram.
  const latest = await base44.entities.Meeting.get(meeting.id);
  if (latest.stage !== "transcribing") {
    return Response.json({ skipped: true, stage: "transcribing", reason: "overtaken" });
  }
  if (latest.stage_detail === "processing") {
    // Check if the lock has expired — the previous call may have timed out
    // (function killed by platform before completing). Without this time
    // check, the meeting would be permanently locked at "processing".
    const ageMs = Date.now() - new Date(latest.updated_date).getTime();
    if (ageMs < LOCK_SECONDS * 1000) {
      return Response.json({ skipped: true, stage: "transcribing", reason: "locked" });
    }
    // Lock expired — previous call timed out. Fall through to retry.
  }
  await base44.entities.Meeting.update(meeting.id, { stage_detail: "processing" });

  const audioUrl = meeting.audio_file_url;
  if (!audioUrl) throw new Error("No audio URL for transcription");

  const route = routeEngine(meeting.language_mode);
  const lang = route?.params?.language || "hi";
  const keyTerms = meeting.key_terms || [];

  const utterances = await transcribeDeepgram(audioUrl, lang, keyTerms);

  // Guard: after Deepgram returns (which can take 30-60s), re-check the
  // meeting state. If another invocation already advanced the stage, or if
  // the existing raw_utterances are more complete, don't overwrite.
  const current = await base44.entities.Meeting.get(meeting.id);
  if (current.stage !== "transcribing") {
    return Response.json({ skipped: true, stage: "transcribing", reason: "overtaken" });
  }
  const existingUtts = (current.raw_utterances || []).filter((u) => u.text && u.text.trim());
  const newCount = utterances.filter((u) => u.text && u.text.trim()).length;
  if (existingUtts.length > newCount * 1.5) {
    // Existing data is significantly more complete — advance without overwriting
    await base44.entities.Meeting.update(meeting.id, {
      stage: "diarizing",
      stage_detail: null,
    });
    return Response.json({ status: "advanced", stage: "diarizing", reason: "kept_existing" });
  }

  await base44.entities.Meeting.update(meeting.id, {
    stage: "diarizing",
    stage_detail: null,
    raw_utterances: utterances.map((u) => ({
      text: u.text, start: u.start, end: u.end, words: u.words || [],
    })),
  });
  return Response.json({ status: "advanced", stage: "diarizing" });
}

// Chunked OpenAI transcription fallback (used when engine === "openai").
// Resumable across invocations to avoid the 5-min function timeout.
const CHUNKS_PER_INVOCATION = 4;

async function doTranscribingOpenAI(base44, meeting) {
  const publicId = meeting.cloudinary_public_id;
  if (!publicId) throw new Error("No Cloudinary public_id for transcription");

  const route = routeEngine(meeting.language_mode);
  const lang = route?.params?.language || "auto";
  const dur = meeting.duration_seconds || 0;

  // Unknown duration — single request (may timeout on long files, but can't chunk)
  if (dur === 0) {
    const utterances = await transcribeOpenAIFull(publicId, lang);
    await base44.entities.Meeting.update(meeting.id, {
      stage: "diarizing",
      stage_detail: null,
      raw_utterances: utterances.map((u) => ({
        text: u.text, start: u.start, end: u.end, words: u.words || [],
      })),
    });
    return Response.json({ status: "advanced", stage: "diarizing" });
  }

  // Determine resume offset from stage_detail or raw_utterances (timeout recovery)
  let offset = 0;
  if (meeting.stage_detail && meeting.stage_detail !== "processing") {
    offset = parseInt(meeting.stage_detail) || 0;
  }
  if (offset === 0 && meeting.raw_utterances && meeting.raw_utterances.length) {
    // Recover from timeout: find where we left off based on last utterance
    const lastUtt = meeting.raw_utterances[meeting.raw_utterances.length - 1];
    offset = Math.ceil((lastUtt.end || 0) / OPENAI_CHUNK_SEC) * OPENAI_CHUNK_SEC;
  }

  const existingUtts = [...(meeting.raw_utterances || [])];
  let chunksDone = 0;

  while (offset < dur && chunksDone < CHUNKS_PER_INVOCATION) {
    const end = Math.min(offset + OPENAI_CHUNK_SEC, dur);
    const chunkUtts = await transcribeOpenAIChunk(publicId, offset, end, lang);
    for (const u of chunkUtts) {
      existingUtts.push({
        text: u.text, start: u.start, end: u.end, words: u.words || [],
      });
    }
    offset = end;
    chunksDone++;

    // Save progress after each chunk (timeout recovery point)
    await base44.entities.Meeting.update(meeting.id, {
      raw_utterances: existingUtts,
      stage_detail: String(offset),
    });
  }

  if (offset >= dur) {
    // All chunks done — advance to diarizing
    await base44.entities.Meeting.update(meeting.id, {
      stage: "diarizing",
      stage_detail: null,
      raw_utterances: existingUtts,
    });
    return Response.json({ status: "advanced", stage: "diarizing" });
  }

  // More chunks remain — return waiting for next invocation
  return Response.json({ status: "waiting", stage: "transcribing", offset });
}

// Stage 2: Check pyannote job (non-blocking). If done, advance to aligning.
// Safety net: if the job ID was lost (race condition), re-submit the job.
async function doDiarizingStage(base44, meeting) {
  if (!meeting.pyannote_job_id) {
    const audioUrl = meeting.audio_file_url;
    if (!audioUrl) {
      // No audio at all — skip with empty identification.
      return advanceStage(base44, meeting, "aligning", { identification: [] });
    }
    // Re-submit pyannote job (safety net for lost job ID).
    const result = await submitPyannoteJob(
      base44, audioUrl, meeting.expected_speaker_ids
    );
    await base44.entities.Meeting.update(meeting.id, {
      pyannote_job_id: result.jobId,
      pyannote_mode: result.mode,
      stage_detail: "submitted speaker identification",
    });
    return Response.json({ status: "waiting", stage: "diarizing", reason: "pyannote re-submitted" });
  }

  const result = await checkPyannoteJob(meeting.pyannote_job_id);
  if (!result.done) {
    // Job still running — clear the lock so the next invocation can check again.
    await base44.entities.Meeting.update(meeting.id, { stage_detail: "waiting for speaker identification" });
    return Response.json({ status: "waiting", stage: "diarizing" });
  }

  const identification =
    meeting.pyannote_mode === "identify"
      ? parseIdentifyOutput(result.output)
      : parseDiarizeOutput(result.output);

  return advanceStage(base44, meeting, "aligning", {
    identification,
    stage_detail: null,
  });
}

// Stage 3: Build transcript from raw_utterances + identification.
async function doAligningStage(base44, meeting) {
  // Sort + filter raw_utterances defensively — guarantees a clean timeline
  // regardless of which engine produced them (guards against whisper-1-style
  // timestamp hallucination producing out-of-order or empty segments).
  const utterances = [...(meeting.raw_utterances || [])]
    .filter((u) => u.text && u.text.trim())
    .sort((a, b) => (a.start || 0) - (b.start || 0));
  const identification = meeting.identification || [];
  const speakerMap = resolveSpeakers(identification);
  const lines = buildTranscript(utterances, identification, speakerMap);

  const unknownSegmentCount = new Set(
    lines.filter((t) => t.speaker_name.startsWith("Unknown")).map((t) => t.speaker_name)
  ).size;
  const participants = Array.from(
    new Set(lines.map((t) => t.speaker_name).filter((n) => !n.startsWith("Unknown")))
  );

  return advanceStage(base44, meeting, "summarizing", {
    transcript: lines,
    unknown_segment_count: unknownSegmentCount,
    participants,
  });
}

// Stage 4: Romanize Indic script. Processes ONE batch per invocation to
// avoid function timeouts on long transcripts. Progress is computed from
// the transcript itself (which lines still have Indic `text`), NOT from
// stage_detail — so a function timeout or error never loses place. Each
// invocation picks up exactly where the last one left off, naturally.
async function doRomanizingStage(base44, meeting) {
  // Romanizing is disabled — skip straight to summarizing for any meeting
  // that reaches this stage (including ones previously stuck here).
  return advanceStage(base44, meeting, "summarizing", {
    transcript: meeting.transcript || [],
  });
}

// Stage 5: Generate summary + action items. Complete.
// Idempotent: if a concurrent call already produced a summary, just finalize.
async function doSummarizingStage(base44, meeting) {
  if (meeting.summary && meeting.summary_status === "completed") {
    await base44.entities.Meeting.update(meeting.id, {
      status: "completed",
      stage: "completed",
      stage_detail: null,
    });
    return Response.json({ status: "completed", meeting_id: meeting.id, reused: true });
  }

  const transcript = meeting.transcript || [];
  const transcriptText = transcript.map((t) => `${t.speaker_name}: ${t.text}`).join("\n");
  const { summary, action_items, summary_status } = await generateSummary(transcriptText);

  await base44.entities.Meeting.update(meeting.id, {
    status: "completed",
    stage: "completed",
    stage_detail: null,
    summary,
    action_items,
    summary_status,
  });
  return Response.json({ status: "completed", meeting_id: meeting.id });
}