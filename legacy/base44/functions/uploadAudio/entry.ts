import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { uploadAudioToCloudinary } from "../../shared/cloudinary.ts";

// Persists a recorded/uploaded meeting audio file to Cloudinary and returns its
// public URL. Accepts a multipart upload (File) from the app, or a JSON body
// with base64 audio (used for testing).
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    const ct = req.headers.get("content-type") || "";
    let file: Blob;
    let filename = "audio";
    let mimetype = "audio/webm";
    if (ct.includes("multipart")) {
      const form = await req.formData();
      const f = form.get("audio");
      if (!f) return Response.json({ error: "audio file required" }, { status: 400 });
      file = f as Blob;
      if ((f as File).name) filename = (f as File).name;
      if ((f as File).type) mimetype = (f as File).type;
    } else {
      const body = await req.json();
      const b64 = body.audio_base64;
      if (!b64) return Response.json({ error: "audio file required" }, { status: 400 });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      mimetype = body.mimetype || mimetype;
      filename = body.filename || filename;
      file = new Blob([bytes], { type: mimetype });
    }
    const { url } = await uploadAudioToCloudinary(file, filename, mimetype);
    return Response.json({ url });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}