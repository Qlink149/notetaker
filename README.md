# MeetingID

Meeting recorder and transcriber for Hindi / Gujarati / English business meetings. Upload or record
audio; a background worker transcribes it with Gemini in 10-minute chunks, stitches the chunks,
measures how much of the speech was actually transcribed, and writes a summary with Claude only when
coverage is high enough.

| Part | Where | Deploys to |
| --- | --- | --- |
| Web app (React + Vite) | `apps/web` | Vercel (root `apps/web`) |
| API (Express) | `apps/api/src/server.ts` | Render web service `meetingid-api` |
| Worker (job loop) | `apps/api/src/worker.ts` | Render background worker `meetingid-worker` |
| Shared schemas | `packages/shared` | — |
| Pure pipeline logic | `packages/pipeline` | — |

Docs: [architecture](docs/ARCHITECTURE.md) · [decisions](docs/DECISIONS.md) · [runbook](docs/RUNBOOK.md).

## Run locally

Requirements: Node 20+, a MongoDB (Atlas or local), the API keys in `.env.example`.

```bash
npm install
cp .env.example .env            # fill in values; never commit .env
cp apps/web/.env.example apps/web/.env.local
npm run build -w @meetingid/shared -w @meetingid/pipeline   # once, for compiled imports
npm run seed -w @meetingid/api  # creates workspace "notetaker" + glossary; login code = WORKSPACE_ACCESS_CODE

npm run dev -w @meetingid/api          # API on :8080
npm run dev:worker -w @meetingid/api   # worker (separate terminal)
npm run dev -w @meetingid/web          # web on :5173
```

Process a local file end to end without the browser:

```bash
npm run eval -w @meetingid/api -- ../../files/200.mp3                         # whole file
npm run eval -w @meetingid/api -- ../../files/200.mp3 --start 300 --duration 120   # a 2-minute cut
npm run eval -w @meetingid/api -- ../../files/200.mp3 --engine deepgram --no-run   # queue only
```

Transcripts are written to `scripts/eval/out/` (gitignored).

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

API tests use an in-memory MongoDB (`mongodb-memory-server` downloads a `mongod` binary the first time)
and the bundled ffmpeg; no API keys are needed.

## Environment variables

| Variable | api | worker | Notes |
| --- | --- | --- | --- |
| `MONGODB_URI`, `JWT_SECRET` | ✓ | ✓ | `JWT_SECRET` ≥ 32 chars |
| `CORS_ORIGINS` | ✓ | | Vercel origin(s); `localhost:5173` always allowed |
| `WORKSPACE_ACCESS_CODE` | seed | | login code set by `npm run seed` |
| `CLOUDINARY_*` | ✓ | ✓ | signed uploads (api), audio derivatives (worker) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | delete only | ✓ | primary engine |
| `DEEPGRAM_API_KEY` | | ✓ | fallback engine + benchmark |
| `ANTHROPIC_API_KEY` | | ✓ | summaries (Claude Haiku 4.5) |
| `PYANNOTEAI_API_KEY` | ✓ | | speaker enrolment (voiceprints used in Phase 2) |
| `WORKER_CONCURRENCY` | | ✓ | parallel jobs per worker, default 2 |
| `VITE_API_URL` | web | | API base URL, e.g. `https://meetingid-api.onrender.com` |

## Deploy

- **Render:** `render.yaml` defines both services and the `meetingid-shared` env group. Fill the
  secret values in the dashboard, then run `npm run seed -w @meetingid/api` once from the API shell.
- **Vercel:** project root `apps/web`; `apps/web/vercel.json` installs from the monorepo root.
  Set `VITE_API_URL`.
