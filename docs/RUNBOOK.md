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

Stages are idempotent: re-running `assemble` rebuilds turns and lines from the stored chunk turns at
no API cost; re-running `summarise` costs one Claude call; re-running `ingest` re-cuts and
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
