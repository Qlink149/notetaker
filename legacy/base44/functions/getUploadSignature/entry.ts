import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";
import { secrets } from "base44:runtime";

async function sha1Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Returns a signed Cloudinary upload payload so the browser can upload audio
// directly to Cloudinary with XHR (real progress bar, no bytes through a
// Base44 function). The folder isolates each user's recordings.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    const cloudName = secrets.get("CLOUDINARY_CLOUD_NAME");
    const apiKey = secrets.get("CLOUDINARY_API_KEY");
    const apiSecret = secrets.get("CLOUDINARY_API_SECRET");
    if (!cloudName || !apiKey || !apiSecret) {
      return Response.json({ error: "Cloudinary not configured" }, { status: 500 });
    }

    const folder = `meetings/shared`;
    const timestamp = Math.floor(Date.now() / 1000);
    // Cloudinary requires params sorted alphabetically for the signature.
    const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = await sha1Hex(paramsToSign + apiSecret);

    return Response.json({
      cloudName,
      apiKey,
      folder,
      timestamp,
      signature,
      // The upload endpoint the browser POSTs to.
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}