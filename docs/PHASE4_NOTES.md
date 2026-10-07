# Phase 4 notes: exports, cost and quality view, hardening, deployment (8 Oct)

## Done

- **Word export** (`apps/api/src/services/export/docx.ts`, route `GET /meetings/:id/export?format=docx&script=roman|native|both`): title, date, summary (headings, bullets, bold), action items and the transcript with time and speaker. Devanagari and Gujarati runs are written with **embedded Noto Sans Devanagari and Noto Sans Gujarati** (`apps/api/assets/fonts`, SIL Open Font License included), so the file reads correctly on a computer without those fonts. A test unzips the file and checks the two embedded font parts, the font table, the font named on each run, and both scripts' text.
- **PDF** remains the browser's print-to-PDF: no HTML-to-PDF path that works without bundling a browser was found, and the brief said not to download one. A server-side PDF would need a browser engine (several hundred MB) or a pure PDF library with complex-script shaping (not available without extra work for Gujarati).
- **Cost and quality page** (`/dashboard`, "Insights"): meetings, hours, recorded spend and provider split, average coverage and how many meetings are under 90 %, how many have voice-checked speakers, per-meeting voices (confident / to review / new), Gemini replies and Deepgram requests stored, pyannote jobs and hours diarized, Gemini keys out of quota, and the blind-audit tally.
- **Login hardening checked**: 10 failed logins per address per 15 minutes then `429` (tested); session tokens are signed, expire after 30 days, are revoked when the access code is rotated, and an expired or wrongly signed token is rejected (tested). Group-recording guests cannot act without their token, cannot file audio in another phone's folder, and cannot join a closed session.
- **Cleanup**: Gemini key ids are env variable names (migration applied to the demo database); stale generated files are not committed; the tunnel is never left open.

## Not done, and why

- **No deployment.** You asked me not to push, and this computer cannot reach the repository. `render.yaml` still builds `shared → pipeline → api` (that order is required: the root-level `npm run build` builds `pipeline` before `shared` and fails; this was already so in Phase 1).
- **No pyannote webhooks.** Jobs are polled (a poll every 15 s from the `diarize` stage); a webhook needs a public URL and a signature check (`docs.pyannote.ai/webhooks`). Worth doing once there is a deployed address; it removes the polling and the 24-hour expiry race.
- **No new authentication system**, as instructed.

## When you deploy

1. Push the branch yourself (nothing here has been pushed). Run the secret scan again first; the one I ran over every commit found no keys.
2. Atlas: allow-list the host's outbound addresses; use a new database name, not `meetingid`, until you want the Phase 1 data there.
3. Set on the host: `JWT_SECRET` (fresh), `MONGODB_URI`, `MONGODB_DB`, `CORS_ORIGINS` (the web address), `CLOUDINARY_*`, `PYANNOTEAI_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY*`, `SUMMARY_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` for real summaries, optionally `SPEAKER_SOURCE=text` to keep Phase 1 behaviour. The new assets folder (`apps/api/assets`) must be deployed with the API.
4. Web: build with `VITE_API_URL` set to the API address (or serve both from one host with a `/api` proxy as the demo does).
5. Free-tier note: the combined API-and-worker process holds the 512 MB limit tight; a long group recording needs more memory than a small instance has.

## Worth doing next

1. **Consent and retention for voiceprints.** A voiceprint is biometric data. Add a consent line to enrolment and a delete-everything-about-this-person action (voiceprints, clips, aliases); pyannote deletes its own results after 24 h but our stored copies stay until deleted.
2. **pyannote cost per hour**, from the billing page, put in the dashboard as a number (it publishes no rate).
3. **Credit alarm**: the first sign of the credit running out was a `402` in the middle of a batch. Check the balance before a batch and show the state on the dashboard.
4. **Re-identify** should list what it would change before changing anything.
5. **Calibrate the thresholds** (accept at ≥ 60 with a margin ≥ 10) on audited data; the overnight values rest on three matches and 21 non-matches.
6. A server-side PDF if clients want one.
7. Rate limits for the host endpoints (the public join endpoint has one).
