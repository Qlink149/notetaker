# Deploying Phase 2: Render (API + worker), Vercel (web), Backblaze B2 (recordings)

Updated 12 Oct. The first deployment (one combined free service, `meetingid-phase2`) is live; this is the target layout and how to move to it.

## 0. What was checked

- **Secrets:** every commit was searched for the real values in both `.env` files and for keys pasted into chat: no match. `.env` is git-ignored.
- **A fresh clone builds and runs** with Render's and Vercel's build commands (install about 2 minutes), and the built server answers health, login, the meetings list, speakers and the Word export.
- **Memory, measured on the compiled worker with a real 74-minute recording** (33.9 MB MP3, 127 MB as 16 kHz FLAC): the worker process peaked at **272 MB** while converting and cutting (ffmpeg adds about 23 MB), **377 MB** while uploading to pyannote and Deepgram, and 364 MB while calling Gemini; start-up is 105 MB. Overall peak **377 MB** with no heap limit on a machine with 8 GB. The assemble, identify and summary stages were not reached (Gemini's free daily quota ran out) but handle only text. The API process alone is about 120 MB.
- **What caused the crashes before:** the pyannote and Deepgram uploads read the whole file into memory (510-590 MB measured for a 127 MB file). Uploads are now streamed.

## 1. Layout: two services, 512 MB each (`render.yaml`)

| Service | Type and plan | What it does | Memory |
|---|---|---|---|
| `meetingid-api` | web, **Free** | the website's API; queues long work | about 120 MB, heap capped at 256 MB |
| `meetingid-worker` | background worker, **Starter, $7/month** | processes recordings, one at a time | peak about 380 MB, heap capped at 320 MB |

- **Do not make both free.** Render gives a workspace 750 free instance hours a month in total; one always-on service is about 744. Two would be suspended mid-month. Background workers are not free, and a free web service sleeps after 15 minutes without traffic (a sleeping worker does no work).
- The free API stays awake only while an uptime monitor pings `https://<api>/api/v1/health` every 10 minutes. It must be the only free service in the workspace.
- `render.paid.yaml` is the same layout with the API on Starter too ($14/month, nothing sleeps, no pinger needed).
- A 512 MB worker leaves about 130 MB of headroom for a 74-minute recording. Two recordings never overlap (concurrency is 1). If you ever see the worker killed for memory (Render dashboard, service, Events: "out of memory"), move it to the 2 GB plan ($25).

Create it: Render, New, Blueprint, pick the repo and branch `phase-2-speaker-identity`; fill the `meetingid-shared` group once. Pushing does **not** redeploy by itself unless Render's GitHub app is connected to the repo: use Manual Deploy otherwise.

## 2. Settings (the `meetingid-shared` group; names match your local `.env`)

| Variable | Value |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | the production database; **not** `meetingid` (Phase 1's) |
| `JWT_SECRET` | a new random string, 32+ characters |
| `CORS_ORIGINS` | the website's address(es), comma separated, no trailing slash |
| `PUBLIC_API_URL` | the API's own address, `https://meetingid-api.onrender.com`; builds audio playback links |
| `STORAGE_PROVIDER` | `cloudinary` (old) or `b2` (see section 3) |
| `CLOUDINARY_*` | still needed to read and delete meetings stored on Cloudinary |
| `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY` | Backblaze B2, S3-compatible (for example `https://s3.us-west-004.backblazeb2.com` and `us-west-004`) |
| `GEMINI_API_KEY1..9` | Gemini keys |
| `GEMINI_FREE_KEYS` | names of the keys that are on Google's **free tier**, e.g. `GEMINI_API_KEY1,GEMINI_API_KEY2`. Google may use free-tier content to improve its products and humans may read it, so these keys are **not used on recordings** unless `GEMINI_ALLOW_FREE_KEYS=true` (demos with non-client audio only). With every key listed, Gemini is disabled |
| `GEMINI_PAID` | `true` once billing is on, so the spend cap counts Gemini cost |
| `DEEPGRAM_API_KEY` | needed: the word clock that places every line comes from it |
| `PYANNOTEAI_API_KEY` | diarization and identification |
| `PYANNOTEAI_VOICEPRINT_API_KEY` | optional second account used only for voiceprints (a job and its media belong to the account that made them, so the request, the clip upload and the polling all use it) |
| `SUMMARY_PROVIDER`, `ANTHROPIC_API_KEY` | `anthropic` and the key: summaries of new meetings fail without it |
| `SPEND_CAP_USD` | 5 by default; raise it deliberately |

The login code is the one already hashed in the database (the same as local); `WORKSPACE_ACCESS_CODE` is only read by `npm run seed`.

## 3. Moving recordings to Backblaze B2

Why: Cloudinary's free plan caps one audio file at 100 MB and is 75 % used; B2 is about $6.95 per TB a month with free downloads up to 3 times what you store. Check on Backblaze's signup page whether the free 10 GB needs a card (sources disagree).

1. Create a **private** bucket and an application key limited to it. Note the S3 endpoint, region, key ID, application key and bucket name.
2. Put the five `B2_*` values in the group and set `PUBLIC_API_URL`.
3. Apply the bucket's browser permissions once: `npm run storage:b2-setup -w @meetingid/api` (allows PUT, GET and HEAD from `CORS_ORIGINS` and localhost).
4. Prove it end to end with a throw-away file: `STORAGE_PROVIDER=b2 npm run storage:b2-check -w @meetingid/api` (presigned upload, worker download, presigned download, range request, refused tampered link, delete).
5. Set `STORAGE_PROVIDER=b2` and redeploy. New recordings go to B2; **older meetings stay on Cloudinary and keep working** (download, playback and delete all fall back to it).

How it behaves: the browser uploads straight to B2 with a presigned PUT (real progress); the worker streams the download; playback goes through a signed link on our API (`/api/v1/audio?k=...&t=...`, signed with `JWT_SECRET`, revoked by rotating it) that redirects to a link valid for 6 hours. B2 cannot cut clips, so voice samples are cut to 30 s on the server first. Keeping a 74-minute recording (30-60 MB) costs about $0.0003-0.0004 a month.

## 4. What a meeting stores in the database

About 2 MB for a 34-minute meeting (about 4.5 MB for 74 minutes): the transcript turns and lines, a Phase 1 snapshot, Gemini's raw replies (about 1 MB), pyannote's replies (diarization and identification) and the Deepgram words. Pyannote's frame-by-frame confidence curve (1.1 MB per reply, nothing reads it) is no longer stored; `npm run p2:trim-responses -w @meetingid/api` (dry run by default, `-- --apply` to change) removes it from replies saved earlier (17.6 MB across the 18 in the demo database). Atlas's free tier holds 512 MB: roughly 100 meetings of 74 minutes (more if shorter), shared with anything else on that cluster.

## 5. Vercel

Root Directory `apps/web`; `VITE_API_URL` = the API's address (build-time: redeploy after changing it). Put the site's address in the API's `CORS_ORIGINS`.

## 6. After it is up (five minutes)

1. `https://<api>/api/v1/health` answers.
2. Log in, open a meeting, play a line, export Word.
3. Upload a short recording and record one from the phone: it processes and shows a summary.
4. Group recording (QR) is not part of the current client scope.

## 7. Known limits to say out loud

- With free Gemini keys: 5 requests a minute and daily quotas (a 74-minute recording did not finish transcribing in a day) and free-tier data terms. Paid keys remove both; keep the free keys out of client recordings (`GEMINI_FREE_KEYS`).
- Speaker names are anonymous until someone names them in the UI; Prachar Speaker A and C may be one person split in two.
- About 3-4 % of each meeting's time (14 % in Prachar) has no verified time and keeps Gemini's own; not shown in the UI yet.
- The blind audit has not been done: no accuracy measured against people.
- Voiceprints are biometric data: add a consent line and a delete-this-person action before real client use.

## 8. Keys that were pasted into chat

Rotate the Base44 pyannote key (`sk_0b3e...`) when you are done. Gemini key 3 is on the free tier.
