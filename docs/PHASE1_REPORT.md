# Phase 1 report

Status: **code complete and tested offline; live acceptance (§9 items 1–6) not yet run.** The live
runs need a filled `.env` (none existed in the repo) and network access to Cloudinary, which was
unreachable from the development machine. Branch: `phase-1-gemini-rebuild`.

## What was built

| Area | Result |
| --- | --- |
| Repo | npm-workspaces monorepo; Base44 code moved to `legacy/base44/`; git history from a baseline commit of the Base44 app |
| `packages/shared` | zod schemas/types for Meeting (small, polled), MeetingData (large), Job, Workspace, Glossary, API bodies, benchmark |
| `packages/pipeline` | chunk planning, seam merge, cross-chunk speaker linking, ≤ 45 s lines, coverage, repetition detection, glossary prompt, strict summary parsing, timestamp normalisation, `SpeakerResolver` + `AnonymousResolver` — 60 unit tests |
| Worker | Mongo job queue with leases and resumable stages: ingest → transcribe (per chunk) → assemble → summarise (coverage-gated) → finalise; benchmark jobs |
| Engines | Gemini (Files API + Interactions API, JSON schema), Deepgram (ported), gemini-3.5-transcribe (benchmark), Sarvam stub |
| API | Express `/api/v1`: access-code login, signed per-meeting uploads, meetings, data, retry stage, summarise anyway, glossary, settings, speakers (enrol ported), benchmark, health with worker heartbeat — 19 route tests |
| Worker tests | generated 2-minute fixture, mocked engine/summariser: happy path to `done`; low coverage → `partial` + `skipped_low_coverage`; truncation retry; crash mid-transcribe resumes without a second engine call; chunk give-up → `partial`; fatal ingest → `failed` with message — 6 tests |
| Web | Base44 SDK removed; typed client; Record (languages, participants, engine), MeetingDetail (stage progress, coverage banner, retry, working Roman/Native/Both), Settings (glossary editor), Benchmark (side by side, promote to eval set) |
| Ops | `render.yaml`, `apps/web/vercel.json`, README, ARCHITECTURE, DECISIONS, RUNBOOK |
| Tools | `npm run seed`, `npm run eval -- <file>` (end-to-end without a browser), `npm run probe -- <files>` (offline audio check) |

## Audit findings → fix

| ID | Fix | Verified by |
| --- | --- | --- |
| T1 | engine per workspace/meeting, Gemini default with explicit languages; no hard-coded Hindi | code; live run pending |
| D1 | coverage gate 0.6, banner + "Summarise anyway" | worker test (low coverage) |
| T2 | both scripts per turn from the transcription call; toggle reads them | unit + UI; live pending |
| L1/L4 | new line on speaker change, pause ≥ 1.2 s, or 45 s | unit tests (`turnsToLines`, `splitLongTurn`) |
| D3 | glossary in Gemini prompt, Deepgram keyterms (≤ 100), summary prompt | code + worker test asserts glossary reaches engine |
| D4/D5 | JSON-schema summary, stripped `---`/`ACTION_ITEMS`, owners limited to transcript labels | unit tests (`parseSummary`) |
| X4 | nothing depends on the browser; worker loop | worker tests |
| F1 | atomic claims + leases; done chunks never re-billed | worker test (dead worker) |
| X1/X2 | retry one stage / failed chunks only; Retryable vs Fatal with backoff | route + worker tests |
| X6 | benchmark rebuilt as jobs with saved EvalRuns | route test; live pending |
| A1 | 16 kHz mono FLAC to every engine | offline probe |
| C3 | duration measured server-side | worker test (`durationSec ≈ 120`) |
| F2 | `GET /meetings/:id` excludes per-turn data | route test (< 20 KB with a 3,000-line meeting) |

## Offline check on the four recordings

`npm run probe` (ingest audio steps, no network):

| File | Minutes | Channels | Speech detected | Chunks | ffmpeg time |
| --- | --- | --- | --- | --- | --- |
| 200.mp3 | 32.2 | 2 | 85 % (150 segments) | 4 | 7 s |
| AOM Meeting part 1.mp3 | 31.8 | 2 | 90 % (138) | 4 | 7 s |
| Meeting-21-9-2026.mp3 | 42.3 | 1 | 85 % (183) | 5 | 7 s |
| Prachar.mp3 | 36.8 | 2 | 100 % (1) | 4 | 8 s |

Prachar's background keeps it above −35 dB throughout, so its coverage denominator is the whole file
(see PHASE2_NOTES).

## Benchmark numbers and cost per hour

**Not measured yet** — no live run was possible. Expected input volume from the documented rate of
~32 audio tokens/s: ~115 k input tokens per hour of audio, plus 5 % for chunk overlap. Actual
input/output tokens per meeting are recorded in `meeting.cost` and per benchmark result; fill this
section from the first `npm run eval` runs and the Gemini-vs-Deepgram benchmark.

## Deviations from the brief

- `ffmpeg-static` → `@ffmpeg-installer/*` (GitHub downloads failed at install; DECISIONS #8).
- Gemini `temperature: 0` cannot be set on the current Interactions API (DECISIONS #9).
- Chunk audio is stored per chunk in Cloudinary (`raw`) so retries, Deepgram and the benchmark
  never re-download the whole file.
- The test fixture is generated with ffmpeg at test time instead of being committed.
- The client export PDFs in `files/` have no extractable text, so glossary spellings were not
  cross-checked against them; the seed glossary is the brief's list plus "Hari Krishna Group".
- Workspace seeded as `notetaker` (as requested), with the Kisna glossary.

## Deferred

- §9 manual acceptance on the four recordings (items 1–6) and the benchmark run.
- Speaker naming with voiceprints (Phase 2; seams in place).
- See `docs/PHASE2_NOTES.md` for the rest.

## Open questions for Phase 2

1. Is ≥ 60 % coverage the right gate once real Gemini coverage numbers are in, and should the
   silence threshold adapt per recording (Prachar)?
2. Do the cross-chunk speaker links hold on real meetings, or are voiceprints needed before
   names are useful?
3. Is Gemini's romanisation good enough for Gujarati, or should `text_roman` come from a separate
   pass for some languages?
4. Which engine wins the benchmark on the four recordings, and at what cost per hour?
