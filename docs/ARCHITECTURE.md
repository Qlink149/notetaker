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

## Phase 2 additions (speaker identity, group recording)

This section describes what the code does now; the older sections above describe Phase 1 and are still right for the parts not listed here.

### Stage order

```
ingest ─┬─ transcribe (one job per 10-min chunk) ──┐
        └─ diarize (pyannote, polled; Deepgram words) ┴─ assemble (+ join) → gapfill → identify → summarise → finalise
multitrack (group recordings only) → ingest
```

- `assemble` waits for both transcription and diarization (`meetingdata.diarize.state` ∈ done / fallback / off). It builds Phase 1's text-linked turns, then
  re-labels them with pyannote speakers (`rebuildTranscript` with a `JoinInput`) unless that would lower coverage. `gapfill` re-runs the same function.
- `diarize` never blocks a worker: it submits, then waits by retrying. Stored results are reused; results older than 24 h or no longer on pyannote's side are submitted again.
  If pyannote is unavailable the meeting continues with Phase 1's text linking (`speakerSource: "text-fallback"`).
- `identify` compares each voice with every known voiceprint (best per person first, ≤ 50), creates anonymous people for new voices, applies names, then hands over to `summarise`. It never fails the meeting.
- `GAPFILL=off` skips gap-fill; `SPEAKER_SOURCE=text` keeps Phase 1 behaviour.

### Join methods (`packages/pipeline/src/join/`)

M1 time overlap (`assignByOverlap`), M3 word clock (`wordClockJoin`: semi-global alignment of Gemini's words to Deepgram's, speaker from pyannote at each word's midpoint),
a per-chunk chooser (`joinMeeting`: M3 where Deepgram covers ≥ 70 % of a chunk's speech) and `labelSpeakersByTime` ("Speaker A, B…").

### New and changed collections

| Collection | Holds |
|---|---|
| `p2_pyannote_responses` | every pyannote job's complete output (diarize, identify, voiceprint) with the request minus voiceprint strings; key label only |
| `p2_media` | pyannote media uploads (they expire) |
| `p2_join_lines` | M1, M3 and chooser results per meeting (experiment output, used by the audit) |
| `p2_identity_runs` | every identify score matrix and the resolution made from it |
| `p2_audits` | blind audit items, naming and answers |
| `speakers` | people: name, `anonymous`, origin voice, voiceprints (string, model, clip, quality) |
| `meetingdata` | + `speakerCards` (one per voice: person, match, status, sample clips), `speakerSource`, `diarize`, `phase1` (the text-linked version) |
| `engineresponses` | + kind `words` (Deepgram word clock) |
| `meetingsessions`, `sessionparticipants`, `sessionloudness` | group recordings |

### Services

- `services/pyannote/client.ts`: pinned-model requests, media upload, 429 handling, polling with back-off. `jobs.ts`: resumable jobs stored in `p2_pyannote_responses`.
- `services/identity/`: `identity.ts` (install the join, cards, apply names, rename a person everywhere), `edits.ts` (merge, split, reassign, name), `enroll.ts` (voiceprints from clips, identify, resolve), `joinInput.ts`.
- `services/export/docx.ts`: Word files with embedded fonts. `services/audit.ts`: audit sampling.
- `packages/pipeline`: `resolveNames` (one-to-one best pairing, threshold and margin), `voiceprintClips`, `names`, `audit`, `multitrack` (alignment, drift, mix, attribution) — all pure and unit-tested.

### Routes added

`/meetings/:id/speakers` (+ `/:diar/name`, `merge`, `split`, `reidentify`), `/meetings/:id/lines/reassign`, `/meetings/:id/export`, `/audit…`, `/dashboard`,
`/sessions…` (host, logged in) and `/join/:code…` (guests, token only; mounted before the login wall).
