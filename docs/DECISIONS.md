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

### 9. Gemini Interactions API without `temperature`; fixed `seed` instead
The current SDK (`@google/genai` 2.24.0) routes audio understanding through
`client.interactions.create` (https://ai.google.dev/gemini-api/docs/audio) with `response_format`
(JSON Schema) and `generation_config`. Evidence, re-checked 2026-10-07:

- The type of `generation_config` on that call (`GenerationConfig_2` in `dist/node/node.d.ts`)
  has `max_output_tokens`, `seed`, `stop_sequences`, `thinking_level`, `thinking_summaries`,
  `transcription_config` and others, but no `temperature`. The `temperature` field in the same
  file belongs to the older `generateContent` `GenerationConfig`, whose documented range is
  (0.0, 2.0], so 0 is not valid there either.
- Live test against `gemini-3.8-flash`: four calls sending `temperature` (0, 0.01, 0, 0.5) all timed
  out with no response, while interleaved calls sending only `seed` completed in 4–6 s (one also
  timed out during the same demand spike).
- `thinking_level: 'minimal'` is rejected for this model (400); `'low'` is accepted.

So the request sends no temperature and a fixed `seed`, which the API documents as making output
"mostly deterministic". The rest of the determinism comes from the strict schema, a precise
instruction, `thinking_level: 'low'`, and output validation with retry. Truncation is detected
from `status: 'incomplete' | 'budget_exceeded'`.

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

### 13. Cloudinary stores only the original recording
The account is on Cloudinary's Free plan: raw files max 10 MB, video/audio max 100 MB (read from
the Admin API `usage` endpoint, 2026-10-07). 16 kHz mono FLAC is ~1.1 MB per minute, so a single
10-minute chunk (~11 MB) already exceeds the raw limit and a 2-hour analysis FLAC (~130 MB) exceeds
the video limit. Phase 1 therefore stores nothing but the original: ingest builds the FLAC and chunks
in its temp directory and uploads chunks straight to the Gemini Files API. When a later job needs a
chunk as a file (Gemini file expired, Deepgram, benchmark, a split chunk), it is re-cut from the
original (`pipeline/chunkAudio.ts`; the original is fetched once per job). `audio.analysisUrl` stays
null; Phase 2 derives analysis audio on demand. Note the same plan caps browser uploads of the
original at 100 MB (≈ 1 h 45 min of 128 kbps MP3); larger files need a paid plan or chunked upload.

### 14. Silence threshold: −35 dB, raised only on noisy recordings
`threshold = max(−35 dB, noise floor + 10 dB)`, capped at −25 dB, where the noise floor is the
10th-percentile RMS level of 0.5 s windows (ffmpeg `astats`). Measured on the four client
recordings (speech share at fixed −35 → with this rule): 200 85 % → 85 %, AOM part 1 90 % → 90 %,
21-9-2026 85 % → 85 %, Prachar 100 % (one segment) → 93 % (117 segments). The brief's
`mean − 18 dB` rule was tried first and rejected: it lowers the threshold below −35 dB on these
files and turned 200 and AOM into 100 % "speech" while leaving Prachar unchanged.

### 15. Several Gemini keys, persisted quota state, one fallback attempt
Phase 1 runs on free-tier Gemini keys (20 requests per model per day per key). Keys are read from
`GEMINI_API_KEY` and `GEMINI_API_KEY1..9`. A daily-quota 429 marks that key exhausted for that
model in MongoDB (`geminiquotas`) until Google's stated reset, so no process spends another request
on it; the job moves to the next key at once. Gemini files belong to one project, so a chunk is
re-uploaded only when its key changes (`chunks.geminiKeyId`). A 503 / timeout on the primary model
gets exactly one request on `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash`, its own quota); the
model that produced each chunk is stored (`chunks.model`). When every key is exhausted the job waits
for the reset without spending an attempt. SDK auto-retries are off (each retry is a request).

### 16. $5 spending cap
`SPEND_CAP_USD` (default 5) is a hard cap on recorded spend across all meetings and benchmarks,
checked before every paid call with a conservative estimate and recorded after it in the `spend`
collection. It counts Claude, and Gemini only when `GEMINI_PAID=true` (free-tier calls cost nothing);
Deepgram is not capped (owner's decision, 2026-10-07). A blocked call fails the job with a clear
"Spending cap reached" message. Each meeting also records `cost.usd` at published paid-tier prices
for reporting.

### 17. Summary handoff for testing (no API spend)
`SUMMARY_PROVIDER=handoff` stores the exact summary prompt (same system prompt, glossary and
`[mm:ss] Speaker N: text` transcript as the API path) in `summaryhandoffs` and waits without using
job attempts. During Phase 1 acceptance an isolated Claude Haiku 4.5 subagent answered each request
from the prompt alone, and the reply went through the same strict `parseSummary` validation
(2 invalid replies → `summaryStatus: failed`). Owner's request, 2026-10-07: save API tokens while
testing. Production keeps `SUMMARY_PROVIDER=anthropic` because the Render worker cannot call a
subagent. Differences from the API path: no JSON-schema constraint (validation only), and the whole
transcript is sent in one request instead of being split at 60k characters.

### 18. Timestamps as "MM:SS.s" with overshoot rescale
Live 10-minute chunks on gemini-3.5-flash ran their clock fast: up to 38 % of a chunk's words had
timestamps past the end of the audio and were clamped onto its last second. The schema now asks for
`MM:SS.s` strings with the chunk's exact length stated in the prompt, and `normalizeChunkTurns`
rescales a chunk's times linearly when the latest one overshoots by more than 3 %. Rerun: 0 piled turns.

### 19. Align chunk clocks at seams before merging
The same sentence appeared up to 26 s apart in two adjacent chunks. `alignSeam` finds sentences both
chunks transcribed in the overlap (≥ 5 words, containment ≥ 0.7, within ±60 s), takes the median
drift and rescales the earlier chunk's clock around its start (bounded to ±15 %) before speaker
linking and the midpoint merge. Speaker linking uses containment similarity and a 15 s window.

### 20. Deepgram language from the workspace
Nova-3 supports hi, gu and en but one language per request, and rejects a restricted
`detect_language` list (400). One workspace language → explicit; several → per-chunk detection.
Detection chose Italian for the Gujarati-heavy 200.mp3 (255 words), so Deepgram stays a fallback.

### 21. Phase 1 deploy: one Render Free web service running API + worker
Render has no free background workers. `src/all.ts` runs the API and the job loop in one process
(concurrency 1) on one Free web service (512 MB, 0.1 CPU) in Singapore, kept awake by an uptime ping
on `/api/v1/health`. Measured local peak 413 MB under `tsx` during a 42-minute assembly; a 2–3 hour
meeting may hit the limit and restart (jobs resume). `render.paid.yaml` keeps the two-service layout.
