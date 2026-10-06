# Decisions

Short ADRs. Newest last.

### 1. MongoDB is the job queue (no Redis in Phase 1)
Jobs are documents claimed with an atomic `findOneAndUpdate` and protected by per-stage leases.
Volume is tens of meetings a day; one datastore means one backup, one connection string, and job state
next to meeting state (retry a stage = update one document). Revisit if throughput needs sub-second
latency or thousands of jobs per minute.

### 2. 10-minute chunks, 30-second overlap
Gemini's output quality and timestamps degrade past 15–20 minutes per request; 5-minute chunks
triple the calls for no gain. Clean cuts lose words at the seam, so chunks overlap by 30 s (whole
sentences) and the seam merge keeps earlier turns up to the overlap midpoint and drops later
near-duplicates within ±8 s, to absorb the ~5 s timestamp drift.

### 3. Gemini Files API, never inline audio
Inline audio is limited to 20 MB per request and is re-sent on every retry. Files are uploaded once
at ingest, reused by retries, re-uploaded if older than 46 h (they expire at 48 h) and deleted at
finalise.

### 4. Every engine gets 16 kHz mono FLAC
The Base44 app sent a 64 kbps stereo MP3 (A1). FLAC is lossless and small at 16 kHz mono. The
64 kbps MP3 derivative is now for playback only.

### 5. Coverage gate at 60 %
`coverage = speech time covered by a transcript turn (±1 s) / speech time from silencedetect
(−35 dB, 0.8 s)`. Below 0.6 the summary is withheld and the meeting is `partial`; the user can
"Summarise anyway". This is what stops a 7 % transcript from producing a confident summary (D1).

### 6. Both scripts come from the transcription call
Gemini returns `text_native` and `text_roman` per turn in the same structured response. The
separate romanising pass, which stalled on long meetings (T2), is gone.

### 7. One shared access code per workspace → JWT
Phase 1 has no user accounts. `lib/auth.ts` is the only file that knows; rotating the code bumps
`tokenVersion` and revokes every token. Phase 4 replaces this file.

### 8. ffmpeg from `@ffmpeg-installer/*`, not `ffmpeg-static`
`ffmpeg-static` downloads its binary from GitHub at install time. That failed on the development
machine (GitHub unreachable) and is a supply-chain risk at deploy time. `@ffmpeg-installer/ffmpeg`
and `@ffprobe-installer/ffprobe` ship the binaries as npm packages per platform. `FFMPEG_PATH` /
`FFPROBE_PATH` override them (e.g. a system ffmpeg in Docker).

### 9. Gemini Interactions API without `temperature`
The current SDK (`@google/genai` 2.x) routes audio understanding through `client.interactions.create`
with `response_format` (JSON Schema) and `generation_config`. Its generation config has no
`temperature` field, so the brief's `temperature: 0` cannot be set. Determinism comes from the strict
schema, a precise instruction, `thinking_level: 'low'`, and output validation with retry.
Truncation is detected from `status: 'incomplete' | 'budget_exceeded'`.

### 10. Model ids are configuration
`GEMINI_MODEL` (default `gemini-3.8-flash`) and the workspace `summaryModel` (default
`claude-haiku-4-5-20251001`) can change without a deploy of code.

### 11. Timestamp repair
Engines sometimes write `2.35` meaning 2 min 35 s. `normalizeChunkTurns` detects this pattern
(every value fits within the chunk length in minutes, no fraction ≥ .60, chunk ≥ 3 min) and
converts. All times are clamped into the chunk and forced non-decreasing.

### 12. Summary uses roman text and structured output
The summariser receives `[mm:ss] Speaker N: text_roman` (native too only when the workspace
prefers native script), the glossary, and the speaker list, and must return one JSON object
(`output_config.format` JSON Schema). Owners not in the speaker list become `Unassigned`; stray
`---` and `ACTION_ITEMS` lines are stripped (D4, D5).
