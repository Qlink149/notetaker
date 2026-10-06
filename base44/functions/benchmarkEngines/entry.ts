import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { transcribeDeepgram } from "../../shared/pipeline.ts";
import { transcribeGeminiFromCloudinary } from "../../shared/gemini.ts";
import { cloudinaryNormalizedMp3Url, publicIdFromCloudinaryUrl } from "../../shared/cloudinary.ts";

// Admin-only: runs the same meeting audio through Deepgram and Gemini and
// returns a side-by-side comparison (utterance count, latency, first 5 lines).
// Does NOT modify the meeting record. OpenAI is added when OPENAI_API_KEY is set.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));
    const { meeting_id } = body;
    if (!meeting_id) return Response.json({ error: "meeting_id required" }, { status: 400 });

    const meeting = await base44.entities.Meeting.get(meeting_id);
    if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });

    const publicId = meeting.cloudinary_public_id || publicIdFromCloudinaryUrl(meeting.audio_file_url);
    if (!publicId) return Response.json({ error: "No Cloudinary audio for this meeting" }, { status: 400 });

    const audioUrl = cloudinaryNormalizedMp3Url(publicId);
    const keyTerms = meeting.key_terms || [];
    const results = {};

    // Deepgram
    try {
      const t0 = Date.now();
      const utterances = await transcribeDeepgram(audioUrl, "auto", keyTerms);
      results.deepgram = {
        utterances: utterances.length,
        duration_ms: Date.now() - t0,
        sample: utterances.slice(0, 8).map((u) => ({ text: u.text, start: u.start, end: u.end })),
      };
    } catch (e) { results.deepgram = { error: e.message }; }

    // Gemini
    try {
      const t0 = Date.now();
      const utterances = await transcribeGeminiFromCloudinary(publicId, meeting.duration_seconds, keyTerms);
      results.gemini = {
        utterances: utterances.length,
        duration_ms: Date.now() - t0,
        sample: utterances.slice(0, 8).map((u) => ({ text: u.text, start: u.start, end: u.end })),
      };
    } catch (e) { results.gemini = { error: e.message }; }

    // OpenAI
    try {
      const { transcribeWithOpenAI } = await import("../../shared/openai.ts");
      const t0 = Date.now();
      const utterances = await transcribeWithOpenAI(publicId, meeting.duration_seconds, "auto");
      results.openai = {
        utterances: utterances.length,
        duration_ms: Date.now() - t0,
        sample: utterances.slice(0, 8).map((u) => ({ text: u.text, start: u.start, end: u.end })),
      };
    } catch (e) { results.openai = { error: e.message }; }

    return Response.json({ meeting_id, title: meeting.title, duration_seconds: meeting.duration_seconds, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}