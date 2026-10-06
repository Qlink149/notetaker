import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { pyannoteHeaders, pollPyannoteJob } from "../../shared/pyannote.ts";
import { uploadAudioToCloudinary, cloudinaryWavUrl, cloudinaryTrimWavUrl } from "../../shared/cloudinary.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    // Accept multipart (File upload), JSON with trim params, or JSON with URL.
    let name, audioFile, audioFileUrl, trim;
    let mimetype = "audio/webm";
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart")) {
      const form = await req.formData();
      name = (form.get("name") || "").trim();
      audioFile = form.get("audio");
      audioFileUrl = (form.get("audio_file_url") || "").trim();
      const trimJson = form.get("trim");
      if (trimJson) trim = JSON.parse(trimJson);
      if (audioFile && audioFile.type) mimetype = audioFile.type;
    } else {
      const body = await req.json();
      name = (body.name || "").trim();
      audioFileUrl = (body.audio_file_url || "").trim();
      trim = body.trim;
      if (body.audio_base64) {
        const bytes = Uint8Array.from(atob(body.audio_base64), (c) => c.charCodeAt(0));
        mimetype = body.mimetype || mimetype;
        audioFile = new Blob([bytes], { type: mimetype });
      }
    }
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });

    let audioUrl = audioFileUrl;
    let voiceprintUrl = "";
    if (trim && trim.cloudinary_public_id) {
      // Enrollment from a meeting segment — build a Cloudinary WAV trim URL.
      // Reject clips > 30s (pyannote voiceprint limit).
      const dur = (trim.end || 0) - (trim.start || 0);
      if (dur > 30) {
        return Response.json({ error: "Clip is too long for a voiceprint (max 30 seconds). Pick a shorter segment." }, { status: 400 });
      }
      if (dur < 3) {
        return Response.json({ error: "Clip is too short for a voiceprint (min 3 seconds)." }, { status: 400 });
      }
      audioUrl = cloudinaryTrimWavUrl(trim.cloudinary_public_id, trim.start, trim.end);
    } else if (audioFile) {
      // Direct recording upload — Cloudinary + WAV transcode.
      const uploaded = await uploadAudioToCloudinary(
        audioFile,
        `voiceprint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mimetype
      );
      // Full recording for playback; first 30s for pyannote (max voiceprint duration).
      audioUrl = cloudinaryWavUrl(uploaded.publicId);
      voiceprintUrl = cloudinaryTrimWavUrl(uploaded.publicId, 0, 30);
    }
    if (!audioUrl) return Response.json({ error: "audio is required" }, { status: 400 });
    // Fall back to the full URL if no trimmed voiceprint URL was set (e.g. trim path).
    const urlForVoiceprint = voiceprintUrl || audioUrl;

    const res = await fetch("https://api.pyannote.ai/v1/voiceprint", {
      method: "POST",
      headers: pyannoteHeaders(),
      body: JSON.stringify({ url: urlForVoiceprint, model: "precision-2" }),
    });
    if (!res.ok) {
      const t = await res.text();
      return Response.json({ error: `pyannote voiceprint create failed: ${t}` }, { status: 502 });
    }
    const created = await res.json();
    const output = await pollPyannoteJob(created.jobId);
    const voiceprint = output && output.voiceprint;
    if (!voiceprint) return Response.json({ error: "No voiceprint returned" }, { status: 502 });

    const speaker = await base44.entities.Speaker.create({ name, voiceprint_id: voiceprint, enrollment_audio_url: audioUrl });
    return Response.json({ speaker });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}