# Runbook

All commands use `mongosh "$MONGODB_URI"` unless noted. Logs are JSON (pino); every worker line
carries `meetingId`, `jobId`, `stage`, `step`.

## Is the worker alive?

`GET /api/v1/health` → `worker.lastHeartbeat` should be under a minute old. If it is stale, check
the `meetingid-worker` service logs on Render and restart it. Restarting is always safe: in-flight
jobs are handed back on SIGTERM, or reclaimed after their lease expires if the process died.

## A meeting shows "failed"

The meeting page shows the stage and a message, with a **Retry** button that re-queues that stage
only. From the API: `POST /api/v1/meetings/:id/retry {"stage": "transcribe"}`.

To see why:

```js
db.jobs.find({ meetingId: ObjectId("…") }).sort({ createdAt: 1 })
  .projection({ stage: 1, step: 1, status: 1, attempts: 1, lastError: 1, runAfter: 1 })
```

| `lastError` looks like | Meaning | Action |
| --- | --- | --- |
| `provider 429` / `RESOURCE_EXHAUSTED` | quota | wait, or raise the quota; then Retry |
| `GEMINI_API_KEY is not set` | env missing on the worker | set it in the env group, redeploy, Retry |
| `Audio file not found` | Cloudinary original deleted | re-upload |
| `The audio format is not supported` | ffprobe could not read it | convert locally (`ffmpeg -i in out.m4a`) and re-upload |
| `Chunk N output truncated/repetitive` | Gemini looped; the chunk is split automatically after 2 bad outputs | if it still fails, Retry transcribe or switch engine |

## A meeting is stuck in "processing"

1. Look at its jobs (query above). `queued` with a future `runAfter` is a backoff: it will run.
2. `running` with an old `lockedAt`: the worker died; another worker reclaims it after the lease
   (≤ 8 min for transcribe). Make sure a worker is running.
3. No queued or running job at all: re-queue the meeting's current stage with the Retry endpoint.

## Re-run one stage by hand

```js
db.jobs.insertOne({ meetingId: ObjectId("…"), stage: "assemble", step: null, status: "queued",
  attempts: 0, maxAttempts: 5, runAfter: new Date(), lockedBy: null, lockedAt: null,
  lastError: null, payload: null, createdAt: new Date(), updatedAt: new Date() })
db.meetings.updateOne({ _id: ObjectId("…") }, { $set: { status: "processing", stage: "assemble", error: null } })
```

Or from a shell: `npm run requeue -w @meetingid/api -- <stage> <meetingId> [...]`.

Stages are idempotent: re-running `assemble` rebuilds turns and lines from the stored chunk turns at
no API cost (stored gap fills are re-applied); re-running `gapfill` spends at most the calls left
under the 6-per-meeting cap on gaps not yet tried; re-running `summarise` costs one Claude call; re-running `ingest` re-cuts and
re-uploads everything and resets all chunks (Gemini is paid again for every chunk).

## Force a summary on a low-coverage meeting

"Summarise anyway" in the UI, or `POST /api/v1/meetings/:id/summarise {"force": true}`.

## Reprocess with Deepgram instead of Gemini

```js
db.meetings.updateOne({ _id: ObjectId("…") }, { $set: { engine: "deepgram" } })
```

Then Retry stage `ingest` (chunks are re-planned and Deepgram reads the stored chunk FLACs).

## Costs

`meeting.cost` accumulates Gemini input/output tokens, Deepgram seconds and Claude tokens, including
calls whose output was rejected and retried.

## Rotate the access code

Settings → Access code, or re-run `npm run seed -w @meetingid/api` with a new
`WORKSPACE_ACCESS_CODE`. Either signs out every device.

## Stale local workers (Windows dev machines)

Stopping the shell that ran `npx tsx src/worker.ts` does not always stop the `node` child. A stale
worker keeps claiming jobs with the code and environment it started with (seen 2026-10-07: an old
worker took a transcribe job with a retired key and failed it). Before a live run, list and kill
leftover workers:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'worker\.ts' } | Select ProcessId, CreationDate
Stop-Process -Id <pid> -Force
```

The worker heartbeat (`db.workerheartbeats.find()`) also shows every worker id that is alive.

## Gemini free-tier quota

`db.geminiquotas.find()` lists keys exhausted per model and until when (Google's reset is midnight
Pacific). Jobs waiting for a reset show `lastError: "Gemini daily quota used up …"` and a `runAfter`
at the reset; they do not use attempts. To add capacity, add `GEMINI_API_KEY3` etc. (a key in another
project) and restart; to clear a wrong mark: `db.geminiquotas.deleteOne({ _id: "<keyId>:<model>" })`.

## Summary handoff (testing only, SUMMARY_PROVIDER=handoff)

1. `npm run handoff -w @meetingid/api -- pending` writes `scratch/handoff/<id>.prompt.txt`.
2. Have an isolated Claude Haiku 4.5 agent read that file, follow its SYSTEM part on its USER part,
   and write only the JSON object to `scratch/handoff/<id>.reply.json`.
3. `npm run handoff -w @meetingid/api -- submit <id> scratch/handoff/<id>.reply.json`.
The worker validates the reply within 15 s; an invalid reply re-opens the request once.

## Re-run only assembly (free, no API calls)

Assembly works from stored chunk turns. Mark the meeting `stage: "assemble"`, `status:
"processing"`, delete its pending summary handoffs, and queue an `assemble` job (see
`POST /meetings/:id/retry {"stage": "assemble"}`).

## Demo (Phase 2 build)

All from the repo root of the Phase 2 worktree. Details and the demo script: `docs/DEMO_HANDOVER.md`.

- `npm run demo` starts API, worker and web against `meetingid_demo` with Gemini switched off; `npm run demo:live` keeps Gemini on.
- `npm run demo:check` runs 11 checks against the running demo; `npm run demo:tunnel` gives phones an https address.
- `npm run demo:snapshot` saves the demo state; `npm run demo:reset` restores it.
- `npm run demo:refresh -w @meetingid/api -- Prachar [--apply]` re-copies meetings the Phase 1 queue has finished; then
  `npm run p2:join -w @meetingid/api -- Prachar`, `npm run demo:reprocess -w @meetingid/api -- <meetingId>`, answer the summary handoffs (see "Summaries in testing"), `npm run demo:reprocess -w @meetingid/api -- --resume`, `npm run demo:snapshot`.
- Experiments (read stored data, write `p2_*` collections): `p2:diarize`, `p2:stats`, `p2:join`, `p2:deepgram`, `p2:identity` (never submits a new full-meeting job without `--submit`), `p2:audit-seed`, `p2:migrate-key-labels`.
