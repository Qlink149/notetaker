# Deploying Phase 2: Render (API + worker) and Vercel (web)

Nothing here has been pushed or deployed by the build sessions. Written 9 Oct for the person who deploys.

## 0. What was checked before you start

- **Secrets:** every commit on `phase-2-speaker-identity` (76 at the time) was searched for the real values in both `.env` files and for the keys pasted into chat: no match. `.env` is git-ignored and was never committed.
- **A fresh clone builds and runs.** The branch was cloned into an empty folder, installed (`npm ci --include=dev`, about 2 minutes) and built with Render's build command and Vercel's build command: all three server packages compile, the web app builds, the embedded fonts are present. The built `dist/server.js` was then started with `NODE_ENV=production` against the demo database and checked: health answers with the database up; a wrong access code gives 401 and the right one logs in; the five meetings list; the new meeting shows Heet as Speaker B; the Word export returns a valid file; the meetings list refuses a request without login; an unknown origin gets no CORS header and `localhost:5173` does.
- **Nothing large or sensitive is tracked** (no audio, no `.env`, no scratch files).

## 1. Push the branch

The worktree has no remote yet.

```
git remote add origin https://github.com/Qlink149/notetaker.git
git push -u origin phase-2-speaker-identity
```

Push the branch, not `main`: `main` and `phase-1-gemini-rebuild` belong to Phase 1 and its running service.

## 2. MongoDB Atlas

- **Database name:** the blueprint uses `meetingid_demo` (the five demo meetings, the people and their voiceprints). Do **not** use `meetingid`: it is Phase 1's database and its own worker is running against it.
- **Network Access:** add Render's outbound addresses for the Singapore region (Render dashboard, service, Connect, Outbound). Use those addresses, not 0.0.0.0/0.
- **One worker per database.** The deployed process runs the API and a worker. If the local demo (`npm run demo`) is running against the same database at the same time, both workers share one job queue and a job can be taken by the one that has no Gemini key. Close the local demo window once Render is up, or point Render at a copy.

## 3. Render (backend)

New, Blueprint, pick the repo and the branch `phase-2-speaker-identity` (`render.yaml` already names it; change it to `main` after merging).

Environment variables (`sync: false` ones are asked for in the dashboard; names are the same as in your local `.env`):

| Variable | Value |
|---|---|
| `MONGODB_URI` | your Atlas connection string (the same cluster as local) |
| `MONGODB_DB` | `meetingid_demo` (already in the blueprint) |
| `JWT_SECRET` | a **new** random string, 32+ characters (do not reuse the local one) |
| `CORS_ORIGINS` | the Vercel URL, for example `https://your-app.vercel.app` (set after step 4, then redeploy) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | as local |
| `GEMINI_API_KEY1`, `GEMINI_API_KEY2`, `GEMINI_API_KEY3` | as local (keys 1 and 2 were out of quota until Fri 9 Oct 05:29 IST; 3 was fresh on 8 Oct) |
| `DEEPGRAM_API_KEY` | as local (needed: the word clock that places every line in time comes from it) |
| `PYANNOTEAI_API_KEY` | the project key (diarization and identification work; new **voiceprints** are refused until a paid plan, the trial allowance is used) |
| `ANTHROPIC_API_KEY` | needed for summaries of **new** meetings (`SUMMARY_PROVIDER=anthropic` in the blueprint). Without it, summarising fails; the five existing meetings already have summaries. For testing only, `SUMMARY_PROVIDER=handoff` waits for someone to answer, as in the demo |
| `WORKSPACE_ACCESS_CODE` | not needed to log in: only a hash is stored in the database, so the **login code is the same one you use locally**. It is only read by `npm run seed` |

Build and start (already in the blueprint): `npm ci --include=dev && npm run build -w @meetingid/shared -w @meetingid/pipeline -w @meetingid/api`, then `npm run start:all -w @meetingid/api`. Order matters: `shared`, then `pipeline`, then `api`.

Free instances have 512 MB and sleep after 15 minutes without traffic: put an uptime pinger on `/api/v1/health` every 10 minutes. A long recording (about 30 minutes or more) is likely to need more memory than the free instance has: use the Starter plan if you want to process new recordings there.

## 4. Vercel (frontend)

- Import the same repo. **Root Directory:** `apps/web`. `vercel.json` there already sets the install command, build command, output directory and the single-page rewrite.
- **Environment variable:** `VITE_API_URL` = the Render URL, no trailing slash (for example `https://meetingid.onrender.com`). It is read at **build** time: change it, then redeploy.
- After the first deploy, copy the Vercel URL into Render's `CORS_ORIGINS` and redeploy the API. Preview deployments use other URLs; add them to `CORS_ORIGINS` (comma separated) if you want to test on them.

## 5. After it is up (five minutes)

1. `https://<render>/api/v1/health` answers.
2. Log in on the Vercel site with the same access code you use locally.
3. The meetings list shows the five meetings. Open Prachar: Heet appears as a speaker; play a line.
4. Open Meeting 8 Oct: Heet is Speaker B. Use Export, Word: the file opens and Devanagari and Gujarati show.
5. Open Insights (`/dashboard`) and the blind audit (`/audit`).
6. Group recording: start one and open the join link on a phone. It needs the public Vercel address, which is why it cannot be tried from `localhost`.

## 6. Known limits to say out loud

- Speaker names beyond Heet are anonymous ("Speaker A (Meeting AOM)") until someone names them in the UI.
- Prachar Speaker A and C may be one person split in two by pyannote (the matches flip between runs); do not claim either is a specific person.
- Roughly 3-4 % of each meeting's time (14 % in Prachar) has no verified time and keeps Gemini's own, which can be off; those lines are marked internally but not in the UI yet.
- The blind audit has not been done: no accuracy figure is measured against people, only agreement with pyannote.

## 7. Keys that were pasted into chat

The Base44 pyannote key (`sk_0b3e...`) and the Gemini key 3 were pasted in the conversation. Rotate the pyannote one when you are done. The Render API key in `.env` was never used by the build sessions.
