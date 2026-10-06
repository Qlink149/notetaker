import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import {
  submitIdentify, submitDiarize, parseIdentifyOutput, parseDiarizeOutput,
  resolveSpeakers, generateSummary,
} from "../../shared/pipeline.ts";
import { pollPyannoteJob } from "../../shared/pyannote.ts";
import { cloudinaryNormalizedMp3Url } from "../../shared/cloudinary.ts";

// SAFELY re-run speaker identification on an already-processed meeting using the
// CURRENT set of enrolled voiceprints, then refresh labels + summary.
//
// "Safe" = only relabel a transcript line when identification confidently
// matches an enrolled voiceprint. Lines that don't match any voiceprint KEEP
// their existing speaker_name — so manually-named speakers (who have no
// voiceprint) are never wiped to "Unknown". Reuses the existing transcript
// (romanized text + timing preserved) — no re-transcription, no re-romanization.
// Re-summarizes only if at least one speaker label actually changed.
export default async function (req) {
  let body = {};
  try { body = await req.json().catch(() => ({})); } catch {}
  const meetingId = body.meeting_id;
  if (!meetingId) return Response.json({ error: "meeting_id required" }, { status: 400 });

  try {
    const base44 = createClientFromRequest(req);
    const meeting = await base44.entities.Meeting.get(meetingId);
    if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });

    const publicId = meeting.cloudinary_public_id;
    if (!publicId) return Response.json({ error: "No cloudinary audio for this meeting" }, { status: 400 });
    const audioUrl = cloudinaryNormalizedMp3Url(publicId);

    // NOTE: we intentionally do NOT flip status to "processing" here. The
    // MeetingDetail page polls processMeeting every 4s while a meeting is
    // "processing", which would race this function and hit a stale job id.
    // Keep the meeting "completed" throughout; only update at the end.
    const allSpeakers = await base44.entities.Speaker.list();
    const enrolled = allSpeakers.filter((s) => s.voiceprint_id);

    let identification;
    if (enrolled.length) {
      const jobId = await submitIdentify(audioUrl, enrolled);
      const output = await pollPyannoteJob(jobId);
      identification = parseIdentifyOutput(output);
    } else {
      const jobId = await submitDiarize(audioUrl);
      const output = await pollPyannoteJob(jobId);
      identification = parseDiarizeOutput(output);
    }

    const speakerMap = resolveSpeakers(identification);
    const segs = [...identification].sort((a, b) => a.start - b.start);

    // Reassign speaker_name ONLY where a voiceprint confidently matched.
    let changed = 0;
    const transcript = (meeting.transcript || []).map((t) => {
      let bestKey = null;
      let bestOverlap = 0;
      const ts = t.start_time || 0;
      const te = t.end_time || 0;
      for (const s of segs) {
        const inter = Math.min(s.end, te) - Math.max(s.start, ts);
        if (inter > bestOverlap) { bestOverlap = inter; bestKey = s.diarizationSpeaker || s.speaker; }
      }
      if (!bestKey) return t;
      const mapped = speakerMap[bestKey];
      // Only adopt a label that is a real enrolled name (not "Unknown ...").
      if (mapped && !mapped.startsWith("Unknown")) {
        if (t.speaker_name !== mapped) { changed++; return { ...t, speaker_name: mapped }; }
      }
      return t;
    });

    const unknownSegmentCount = new Set(
      transcript.filter((t) => t.speaker_name.startsWith("Unknown")).map((t) => t.speaker_name)
    ).size;
    const participants = Array.from(
      new Set(transcript.map((t) => t.speaker_name).filter((n) => !n.startsWith("Unknown")))
    );

    let summary = meeting.summary || "";
    let action_items = meeting.action_items || [];
    let summary_status = meeting.summary_status || "completed";

    // Re-summarize only when speaker labels actually changed.
    if (changed > 0) {
      try {
        const transcriptText = transcript.map((t) => `${t.speaker_name}: ${t.text}`).join("\n");
        const result = await generateSummary(transcriptText);
        if (result.summary) summary = result.summary;
        if (result.action_items) action_items = result.action_items;
        summary_status = result.summary_status || "completed";
      } catch { /* keep existing summary if regeneration fails */ }
    }

    await base44.entities.Meeting.update(meetingId, {
      status: "completed",
      stage: "completed",
      stage_detail: null,
      transcript,
      participants,
      unknown_segment_count: unknownSegmentCount,
      summary,
      action_items,
      summary_status,
      identification,
    });

    return Response.json({
      status: "completed", meeting_id: meetingId,
      relabeled_lines: changed,
      participants, unknown_count: unknownSegmentCount,
    });
  } catch (error) {
    try {
      const b44 = createClientFromRequest(req);
      await b44.entities.Meeting.update(meetingId, {
        status: "completed", stage: "completed", stage_detail: null,
        error_message: error.message,
      });
    } catch {}
    return Response.json({ error: error.message, meeting_id: meetingId }, { status: 500 });
  }
}