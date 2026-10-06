import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { pyannoteHeaders, pollPyannoteJob } from "../../shared/pyannote.ts";
import { cloudinaryTrimWavUrl } from "../../shared/cloudinary.ts";

// Relabel an unknown speaker in a meeting. Renames the speaker EVERYWHERE:
// transcript, action_items, and summary text. Rejects duplicate speaker names.
// When naming a NEW speaker, also creates a voiceprint from that speaker's
// audio segments in the meeting recording — so the real person never needs
// to be onboarded separately.

const MIN_CLIP_SEC = 3;
const MAX_CLIP_SEC = 30; // pyannote voiceprint limit

// Pick the best contiguous audio block for a speaker from the transcript.
// Merges adjacent lines (gap < 0.5s) into blocks, then returns the longest
// block capped at MAX_CLIP_SEC. Returns null if nothing usable.
function bestClipForSpeaker(transcript, speakerName) {
  const segs = (transcript || [])
    .filter((t) => t.speaker_name === speakerName && t.start_time != null && t.end_time != null)
    .map((t) => ({ start: t.start_time, end: t.end_time }))
    .sort((a, b) => a.start - b.start);
  if (!segs.length) return null;

  // Merge adjacent segments into contiguous blocks
  const blocks = [];
  let cur = { ...segs[0] };
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].start - cur.end < 0.5) {
      cur.end = Math.max(cur.end, segs[i].end);
    } else {
      blocks.push(cur);
      cur = { ...segs[i] };
    }
  }
  blocks.push(cur);

  // Pick the longest block
  blocks.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const best = blocks[0];
  let dur = best.end - best.start;
  if (dur < MIN_CLIP_SEC) return null;
  // Cap at MAX_CLIP_SEC (take from the start of the best block)
  const end = dur > MAX_CLIP_SEC ? best.start + MAX_CLIP_SEC : best.end;
  return { start: best.start, end };
}

// Create a pyannote voiceprint from a trimmed audio URL, return voiceprint string.
async function createVoiceprint(audioUrl) {
  const res = await fetch("https://api.pyannote.ai/v1/voiceprint", {
    method: "POST",
    headers: pyannoteHeaders(),
    body: JSON.stringify({ url: audioUrl, model: "precision-2" }),
  });
  if (!res.ok) throw new Error(`voiceprint create failed: ${await res.text()}`);
  const created = await res.json();
  const output = await pollPyannoteJob(created.jobId);
  return output && output.voiceprint;
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json();
    const { meeting_id, target_name, speaker_id, new_name } = body;
    if (!meeting_id || !target_name)
      return Response.json({ error: "meeting_id and target_name required" }, { status: 400 });

    let finalName = null;
    let sp = null;

    // Fetch the meeting first so a bad meeting_id doesn't orphan a new speaker.
    const meeting = await base44.entities.Meeting.get(meeting_id);
    if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });

    if (speaker_id) {
      const existing = await base44.entities.Speaker.get(speaker_id);
      if (!existing) return Response.json({ error: "Speaker not found" }, { status: 404 });
      finalName = existing.name;
    } else if (new_name) {
      // Reject duplicate names — check the caller's own speakers (RLS-scoped).
      const existing = await base44.entities.Speaker.filter({ name: new_name.trim() });
      if (existing && existing.length) {
        return Response.json({
          error: `A speaker named "${new_name.trim()}" already exists. Use the existing speaker or choose a different name.`,
        }, { status: 409 });
      }
      // Create the speaker first (without voiceprint), then try to build one
      // from the meeting audio below. Voiceprint creation is best-effort: if
      // it fails (no audio, no usable segment, pyannote error), the speaker
      // is still created so the relabel succeeds.
      sp = await base44.entities.Speaker.create({ name: new_name.trim(), voiceprint_id: "" });
      finalName = sp.name;
    } else {
      return Response.json({ error: "speaker_id or new_name required" }, { status: 400 });
    }

    // Rename in transcript
    const transcript = (meeting.transcript || []).map((t) =>
      t.speaker_name === target_name ? { ...t, speaker_name: finalName } : t
    );

    // Rename in action_items (update speaker_name in each item)
    const action_items = (meeting.action_items || []).map((a) =>
      a && a.speaker_name === target_name ? { ...a, speaker_name: finalName } : a
    );

    // Rename in summary text (string replace)
    let summary = meeting.summary || "";
    if (summary && summary.includes(target_name)) {
      summary = summary.split(target_name).join(finalName);
    }

    const unknownSegmentCount = new Set(
      transcript.filter((t) => t.speaker_name.startsWith("Unknown")).map((t) => t.speaker_name)
    ).size;
    const participants = Array.from(
      new Set(transcript.map((t) => t.speaker_name).filter((n) => !n.startsWith("Unknown")))
    );

    await base44.entities.Meeting.update(meeting_id, {
      transcript,
      action_items,
      summary,
      unknown_segment_count: unknownSegmentCount,
      participants,
    });

    // Best-effort: create a voiceprint from the named speaker's audio segments
    // so they're recognized automatically in future meetings (no re-onboarding).
    let voiceprintCreated = false;
    let voiceprintError = null;
    if (new_name && sp && meeting.cloudinary_public_id) {
      try {
        const clip = bestClipForSpeaker(meeting.transcript, target_name);
        if (clip) {
          const clipUrl = cloudinaryTrimWavUrl(meeting.cloudinary_public_id, clip.start, clip.end);
          const voiceprint = await createVoiceprint(clipUrl);
          if (voiceprint) {
            await base44.entities.Speaker.update(sp.id, {
              voiceprint_id: voiceprint,
              enrollment_audio_url: clipUrl,
            });
            voiceprintCreated = true;
          }
        }
      } catch (err) {
        voiceprintError = err.message || String(err);
      }
    }

    return Response.json({ status: "ok", meeting_id, voiceprint_created: voiceprintCreated, voiceprint_error: voiceprintError });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}