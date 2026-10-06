# Architecture

## Services

```
Browser (Vercel) ──signed upload──▶ Cloudinary (original audio)
   │  ▲
   │  └── polls GET /meetings/:id (≈1 KB) every 4 s while processing; GET /data once
   ▼
API (Render web) ──writes──▶ MongoDB ◀──claims jobs── Worker (Render background worker)
                              meetings, meetingdata,         │
                              jobs, workspaces, …            ├─▶ ffmpeg (bundled)
                                                             ├─▶ Cloudinary (FLAC + chunks)
                                                             ├─▶ Gemini Files + Interactions API
                                                             ├─▶ Deepgram (fallback / benchmark)
                                                             └─▶ Anthropic (summary)
```

The API never does long work: it validates, writes Mongo, and queues jobs. The worker runs
`claim → run stage → persist → enqueue next`. Every stage is idempotent and resumable from Mongo, so
a deploy, crash or restart only delays work.

## Pipeline

| Stage | Job granularity | Does | Writes |
| --- | --- | --- | --- |
| `ingest` | per meeting | download original, ffprobe, 16 kHz mono FLAC, silencedetect → speech segments, plan 10-min chunks (30 s overlap, no tail < 90 s), cut + store each chunk, upload to Gemini Files | Meeting.durationSec/audio/progress, MeetingData.chunks/speechSegments; one `transcribe` job per chunk |
| `transcribe` | per chunk (`step` = index) | one engine call; reject truncated or looping output (retry, then split the chunk in half); normalise times to absolute seconds | chunk.rawTurns + status; Meeting.progress, cost |
| `assemble` | per meeting | link speaker labels across chunk overlaps, merge seams (midpoint + dedupe), lines ≤ 45 s, coverage vs speech segments, speaker names via `SpeakerResolver` | MeetingData.turns/lines/speakerMap; Meeting.coverage |
| `summarise` | per meeting | gate: coverage < 60 % → `skipped_low_coverage` (unless forced); else Claude JSON summary | Meeting.summary/actionItems/summaryStatus, cost |
| `finalise` | per meeting | `partial` if coverage < 60 % or any chunk failed, else `completed`; delete Gemini files | Meeting.status, stage `done` |
| `benchmark` | per meeting × engine | run an engine over an ingested meeting's chunks | EvalRun.results |

The last transcribe job to finish moves the meeting to `assemble` with a conditional update on
`stage: 'transcribe'`, so exactly one job enqueues assembly.

### Meeting state machine

```
status:  uploaded → processing ──────────────────────────────▶ completed | partial
                         │                                         ▲
                         └──(job exhausted / fatal)──▶ failed ──retry stage──┘
stage:   ingest → transcribe (n/m) → assemble → summarise → finalise → done
```

A transcribe chunk that fails permanently does not fail the meeting: it is marked `failed`, the
meeting assembles what exists and ends `partial`. A summariser outage leaves `summaryStatus: failed`
with a retry, but the transcript stays available.

## Data model

- **Meeting** (small, polled): status, stage, progress, coverage, summary, action items, error, cost.
  Kept well under 20 KB.
- **MeetingData** (large, fetched once): chunks with raw turns, merged turns, display lines,
  speech segments, speaker map.
- **Job** (the queue): `status`, `runAfter`, `lockedBy/lockedAt`, `attempts`, `step`, `payload`.
  Index `(status, runAfter)`. Leases: ingest 5 min, transcribe 8 min, assemble 2 min, summarise 5 min,
  finalise 2 min, benchmark 20 min; the running worker renews its lease every 30 s.
- **Workspace** (+ hashed access code, token version, settings), **Glossary**, **Speaker**
  (voiceprints for Phase 2), **EvalSet / EvalRun**, **WorkerHeartbeat**.

Schemas are mirrored as zod in `packages/shared`.

## Retries

`RetryableError` (429, 5xx, network, timeouts, truncated / looping / invalid output): backoff
`2^attempts × 15 s`, max 5 attempts. `FatalError` (other 4xx, missing audio, unsupported format):
stop at once. When a job gives up, the meeting shows the stage and a human message, and
`POST /meetings/:id/retry {stage}` re-queues that stage only (for `transcribe`, only the failed
chunks).

## Phase 2 seams

- `TranscriptionEngine` (`apps/api/src/services/engines/types.ts`): Gemini, Deepgram,
  gemini-transcribe and a Sarvam stub.
- `SpeakerResolver` (`packages/pipeline/src/speakers.ts`): `AnonymousResolver` today
  (`Speaker n`); `VoiceprintResolver` (pyannote) plugs in at the assemble stage. The FLAC
  `analysisUrl` is kept for it.
- `services/pyannote/client.ts` and the `Speaker` model / enrol route are ported and compiling.
