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

### 22. Where turn times come from (provenance flags)
Every place a time is changed rather than taken from the engine, in order:

| Step | Where | What happens | Flag |
|---|---|---|---|
| Minute.second repair | `normalizeChunkTurns` | `2.35` read as 2 min 35 s when the whole chunk looks written that way | `timeScaled` |
| Overshoot rescale | `normalizeChunkTurns` | if the latest timestamp exceeds the chunk length by > 3 %, every time in the chunk × (length / latest) | `timeScaled` |
| Clamp | `normalizeChunkTurns` | a time still outside [0, chunk length] (or not a number) is clamped to the nearest bound | `timeEstimated` |
| Monotonic start | `normalizeChunkTurns` | a start earlier than the previous turn's start is pushed forward to it | `timeEstimated` |
| Zero-length fill | `normalizeChunkTurns` | an end < 0.05 s after the start is set to start + 0.4 s × words (bounded by the next turn) | `timeEstimated` |
| Seam alignment | `assembleChunks` → `alignSeam` | the earlier chunk's clock × factor (median drift from shared sentences, ±15 % max) | `timeScaled` |
| Long-turn split | `turnsToLines` → `splitLongTurn` | a turn > 45 s is split by word share; piece times are interpolated | `timeEstimated` |

`timeEstimated` / `timeScaled` are optional booleans on `Turn` and `Line` (a line carries a flag if any
turn merged into it does). Unflagged times are the engine's own, only re-based by the chunk offset.
Rescaled times are still the engine's relative timing, corrected for a clock error; estimated times
are not engine timing at all. Phase 2 should prefer unflagged turns when choosing voiceprint clips.
Meetings transcribed before this change carry flags only from assembly (seam alignment, splits);
normalisation-stage flags appear for chunks transcribed from now on.

## 23. Gap fill: re-transcribe speech the chunk calls skipped

Measured on the finished meetings, Gemini sometimes leaves detected speech untranscribed: AOM had
3 stretches over 5 s (145 s, all at chunk seams), Meeting 21-9 had 5 (63 s, four mid-chunk). A new
`gapfill` stage runs between `assemble` and `summarise`:

- `findTranscriptGaps` lists detected speech not covered by any turn (turns widened by 1 s, as in the
  coverage metric; pieces < 2 s apart joined), keeping gaps with ≥ 5 s of speech, longest first.
- Each gap is cut from the original with 5 s of padding either side and sent with the same prompt
  and glossary as a chunk. At most **6 calls per meeting**, failed ones included; gaps already
  tried are never retried, so a re-run cannot pay twice for the same audio.
- Each call is stored in `MeetingData.gapFills` as soon as it returns (gap-local speaker labels).
  Assembly re-applies them: labels are linked to the meeting's through the padding (both
  transcripts cover it); unmatched labels become new speakers; only turns whose midpoint lies in
  the gap (±2 s) are kept, and repeats of existing turns within ±8 s are dropped.
- Out-of-quota errors pause the stage (the job waits for the reset); other failures mark that gap
  `failed` and move on. The spend cap applies as for chunks.

## 24. Roman-script leak check

Gemini occasionally leaves a native-script word in `text_roman` (Meeting 21-9: 4 of 546 turns, e.g.
"chal रहा है"). Assembly now runs `repairRomanLeaks` on every turn: any Devanagari or Gujarati run in
`textRoman` is transliterated in place with a fixed table (Gujarati is mapped onto the parallel
Devanagari block; schwa deletion only at word end; final "ee"/"aa" written "i"/"a"), and the turn and
its line are marked `romanFix: "transliterated"`. Other Indic scripts are left as they are and
marked `"unrepaired"`. No engine call is made: a per-turn retry would cost a request from the
20-per-day free quota to fix one or two words, and the table is deterministic and unit-tested.
`textNative` is never changed.

## 25. Every engine reply is stored untouched

From 2026-10-07 (before Prachar's remaining chunks), every Gemini reply is saved in the
`engineresponses` collection, one document per call:
- The reply: `text` is the model's output exactly as returned, and `response` is the full interaction object.
- What produced it: `model`, `promptVersion` (`TRANSCRIBE_PROMPT_VERSION`, bumped whenever the
  template or schema changes), `promptHash`, and the full `prompt` and `userText`.
- Where the audio came from: `startSec`/`endSec` of the audio sent, `chunkIndex`, `kind` (`chunk`, `gapfill` or `benchmark`).
- Billing: `usage` and `keyLabel`, the env variable name of the key used (e.g. `GEMINI_API_KEY1`).
  Never the key, part of it, or a hash of it.
- Outcome: `error` is null when the reply was used; otherwise the reason it was not (`truncated`,
  `repetitive`, invalid JSON, bad status).

Replies that were rejected are kept too, since they were paid for. A chunk's `responseId` and a gap
fill's `responseId` point to the reply its cleaned turns came from, and
`turnsFromStoredResponse()` rebuilds those turns with no engine call. Re-assembly, re-timing
experiments and Phase 2 work therefore never need quota.

Size is about 50–150 KB per 10-minute reply, kept outside `MeetingData` so that document stays small.
Deleting a meeting deletes its replies. Deepgram replies are not stored, because the engine returns no raw object.

Meetings transcribed before this change (21-9, 200, AOM, and Prachar chunk 0) have no stored
replies. Their only engine output is the cleaned `rawTurns`.

`response` is the JSON body Google returned. The SDK attaches `sdkHttpResponse` to every reply: the
HTTP *response* headers plus the raw `Response` object. `storableResponse()` drops it before saving.
The API key travels only in the request header, which the SDK never returns. As a last guard, any
configured Gemini key value found in `response` or `text` is replaced with `[redacted]` (tested).

## 26. pyannote facts Phase 2 relies on (checked 2026-10-07)

Source: docs.pyannote.ai (llms.txt index, API reference) and `https://docs.pyannote.ai/openapi.json`.
Nothing below is taken from the Base44 code.

- **Endpoints** (`https://api.pyannote.ai`, `Authorization: Bearer $PYANNOTEAI_API_KEY`): `POST /v1/diarize`,
  `POST /v1/identify`, `POST /v1/voiceprint`, `GET /v1/jobs/{jobId}`, `POST /v1/media/input` (returns a
  pre-signed PUT URL for a `media://<key>` name), `GET /v1/test`. Jobs are asynchronous; status is one of
  `pending | created | running | succeeded | failed | canceled`. Webhooks exist, but nothing local is
  reachable, so we poll.
- **Models.** `precision-2` (the default when `model` is omitted), `precision-3` (more accurate, opt-in),
  and `community-1` (diarize only; no voiceprint or identify). Voiceprints are model-specific, so every
  request pins `model` and every stored voiceprint records the model it came from.
- **Diarize/identify parameters used.**
  - `numSpeakers`, or `minSpeakers` ≤ `maxSpeakers` (all ≥ 1).
  - `exclusive: true` adds `exclusiveDiarization`, the same segments with overlap removed.
  - `turnLevelConfidence: true` adds a `confidence: {SPEAKER_xx: 0–100}` map to each segment.
  - `confidence: true` adds a top-level *frame-level* curve `{score[], resolution}`. It is **not available
    on precision-3**, so we request it only on precision-2.
  - `vadSensitivity` and `crosstalkSensitivity` (−5..5) are precision-3 only and left at 0.
- **Identify.**
  - `voiceprints`: 1–50 entries of `{label, voiceprint}`. The label is at most 100 characters and must not
    start with `SPEAKER_`; the voiceprint string is at most 20,000 characters.
  - `matching.exclusive` (default true): one voiceprint per speaker.
  - `matching.threshold` (0–100, default 0): no match below it.
  - Output adds `identification[]` (segments with `diarizationSpeaker` and `match`, which may be null) and
    `voiceprints[]` of `{speaker, match, confidence: {label: 0–100}}`, one entry per diarization speaker.
    Those per-speaker scores are what our own name resolution uses. Identification confidence measures the
    voice match and is distinct from turn-level diarization confidence.
- **Voiceprint.** One clip of at most 30 s, one speaker, no overlap; no minimum is documented (we
  reject clips under 6 s). The output is `{voiceprint}`.
- **Retention.** Every job's output is deleted 24 h after the job completes, including voiceprints.
  Raw output is therefore stored immediately in `p2_pyannote_responses` and voiceprint strings on the
  `Speaker`. Media uploads are kept "at least 24 hours" (API spec; the tutorial says up to 48 h). We
  re-upload any upload older than 20 h.
- **Rate limits.** Per team, a 60 s window: 100/min for submissions and media, 300/min for job reads.
  A 429 carries `Retry-After`. Media upload can return 402 when no subscription is active.
- **Price.** Plans are Developer €19/month and Starter €99/month, each including the same amount of usage
  credit, with a 30-day trial. Neither the docs nor the pricing page gives a per-hour rate; Phase 2
  measures it from account usage and reports it in PHASE2_REPORT.
- **Audio.** Phase 1 stores only the original in Cloudinary (#13). For pyannote, the 16 kHz mono FLAC is
  built locally with the same `toAnalysisFlac` used for Gemini and uploaded through the media endpoint as
  `media://p2-<meetingId>.flac`. Enrolment clips are cut with `cutFlac` from the same FLAC, so meetings
  and voiceprints see an identical transform.

## 27. Overnight demo build: standing decisions (8 Oct)

- **Repo not pushed.** The owner said not to push (a push from this machine is not possible). Everything is
  committed locally on `phase-2-speaker-identity`; the deploy block is skipped and the local demo is prepared instead.
- **Summaries.** `ANTHROPIC_API_KEY` is removed from the worktree `.env`; `SUMMARY_PROVIDER=handoff` (the
  repo's name for the subagent provider). Summaries come only from the handoff flow.
- **Demo database `meetingid_demo`.** Copied from `meetingid` by `npm run demo:copy` (upsert by `_id`, source read-only).
  `jobs` and `workerheartbeats` are never copied, because queued Phase 1 jobs would spend Gemini quota in a demo worker.
  The brief's collection `meetingdatas` is `meetingdata` in this codebase.

## 28. Join: M1 + M3 chooser, measured (8 Oct, 0 Gemini calls)

Inputs: pyannote precision-2 exclusive diarization (#26), Phase 1's stored turns, and one Deepgram
nova-3 request per whole meeting (`hi`; `gu` for "200"), stored in `engineresponses`
(engine `deepgram`, kind `words`). A whole file per request rather than six 10-minute chunks means
one global clock and no seams, and fits the "6 Deepgram jobs" budget (4 used).

- **Alignment must be semi-global.** The first version aligned each block end to end against a Deepgram
  window 75 s longer than the block, which rewarded dragging Gemini words onto later Deepgram words:
  21-9 coverage fell to 0.914 (Phase 1: 0.963) and 185 s of speech was left without a turn. Letting
  unused Deepgram words at either end cost nothing fixed it (coverage 0.985).
- **Result** (`npm run p2:join`):

  | Meeting | M1 speakers | M3 speakers | Phase 1 speakers | Coverage M3 (Phase 1) | Gemini words matched | M1/M3 agreement |
  |---|---|---|---|---|---|---|
  | 21-9 | 6 | 5 | 11 | 0.985 (0.963) | 4583 / 7748 | 0.64 |
  | 200 | 4 | 4 | 11 | 0.992 (0.992) | 2253 / 4843 | 0.75 |
  | AOM | 7 | 7 | 18 | 1.000 (0.916) | 4046 / 5852 | 0.84 |

  Matched words are anchors; the rest take time and speaker from their neighbours. Lines were ≤ 45 s throughout.
- **Chooser.** M3 for a chunk when Deepgram's words cover ≥ 0.70 of that chunk's speech, else M1. All chunks
  of 21-9, 200 and AOM qualified. Prachar chunk 3 (the only one with Gemini turns yet) scored 0.446 and uses M1:
  Deepgram found about 97 words/min there against 184 for the other Hindi meetings, with similar confidence (0.83),
  so the speech really is sparser; no second Deepgram request was spent on `gu`.
- **Where M1 and M3 disagree, M3 wins** (decision 2). The agreement figures are not accuracy: only the blind audit measures that.
- **Rule kept:** if a join's coverage is below Phase 1's for a meeting, Phase 1's lines are kept. It did not trigger.

## 29. Cross-meeting identity: scoring, thresholds, and the credit stop (8 Oct)

- **Score used: pyannote's own per-speaker aggregate** (`voiceprints[].confidence`, 0–100), with the identify
  job's speakers mapped to ours by time overlap (≥ 70 % of a speaker's speech). My first version, the
  duration-weighted mean of per-segment scores, diluted a real match from 78 to 59.6 because many short
  segments score low; it is kept only for voices the job split differently (`buildScoreMatrixFromSegments`).
- **Thresholds (decision 4): accept at score ≥ 60 with a margin ≥ 10** over the runner-up, one person per voice.
  Observed in the three identify runs (21-9's four people against AOM, Prachar, 200): every non-match scored
  16–48, every accepted match 78–90 (AOM 78, 200 85, Prachar 90). The gap between 48 and 78 is wide, so 60 is
  not sensitive to the exact value. Margins were 11, 47 and 62. AOM's match is the weakest: the same voice scored
  67 against a second 21-9 person.
- **pyannote credits ran out** during the third voiceprint batch: `POST /v1/voiceprint` now returns 402
  "Insufficient credits and no active subscription" (also with a dummy URL). The 8 diarizations, 10 voiceprints
  (21-9) and 3 identify jobs completed before. I did not upgrade or pay (hard rule). Effects: the new people for
  AOM, Prachar and 200 exist (anonymous, with sample clips) but have **no voiceprints yet**; re-running
  `npm run p2:identity -- AOM Prachar 200` after a top-up enrols them (idempotent, skips clips already enrolled).
  Until then only 21-9's four voices can be recognised in other meetings.
- **Guard.** Identity scripts never submit a new full-meeting identify job unless `--submit` is given.
- **Names.** Voices keep per-meeting labels (Speaker A, B…) in transcripts until a person is named; the card shows
  "same voice as Speaker D (Meeting 21/9), score 78". Naming a person renames them in every linked meeting.

## 30. Pipeline integration (8 Oct)

- **Stage order:** `ingest → [transcribe ∥ diarize] → assemble (with the join) → gapfill → identify → summarise → finalise`.
  The brief's separate `join` stage is part of `assemble` (and of the re-assembly gap-fill does): gap-filled turns need
  pyannote speakers too, and one function (`rebuildTranscript`) does it everywhere.
- **Waiting without holding a worker:** `diarize` polls once per run and waits by retrying ("waiting" retries do not use attempts);
  assembly starts only when both transcription and diarization are finished.
- **Fallback:** if pyannote refuses (no key, 402, 400/401/403, a failed job) or retries run out, the meeting continues with
  Phase 1's text linking and `speakerSource: "text-fallback"`; the review screen says so. Rate limits (429) and 5xx are retried.
- **A join may not lower coverage** (tolerance 0.002) below the text-linked version; if it would, the text-linked lines are kept.
- **Phase 1's text-linked turns, lines and speaker map** are stored in `meetingdata.phase1` whenever pyannote speakers replace them.
- **`GAPFILL=off`** skips gap-fill (the one stage that calls Gemini again after transcription). Used by `demo:reprocess`, which also
  removes the Gemini keys from its own process, so "0 new Gemini calls" holds by construction.
- **Stored pyannote output is reused:** a successful `stageA` diarization counts as the pipeline's result; a result older than 24 h or one pyannote
  no longer has is resubmitted.
- **Key ids** are env variable names; the Phase 1 hash is only recognised when reading old records.
- **Reprocessing tonight:** 21/9, AOM and 200 ran assemble → identify → summarise from stored output with 0 new Gemini calls. Summaries were written by
  isolated Haiku subagents answering the handoffs and passed the same strict validation as the Anthropic path. Prachar waits for the other session.

## 31. Group recording and Phase 4 (8 Oct)

- **Parts are WAV, not browser codecs:** MediaRecorder parts are not independently decodable and have gaps between restarts. 16 kHz mono PCM parts are exact
  and about 1.9 MB a minute.
- **Alignment convention:** `fineSec` in the report is the correction to add to the coarse start, so `coarseSec + fineSec` is a phone's real start relative to the reference phone.
  Everything is aligned to the reference phone's content, so that phone's own timestamp error is shared by all.
- **Level matching before choosing a microphone**, with hysteresis and no switching in silence. Plain loudest-wins flipped between phones whenever their noise floors differed by chance.
- **Attribution is display only.** It never changes a name.
- **The public router is mounted before the workspace router** (which requires login for everything after it); guests are authenticated by participant token only.
- **PDF stays print-to-PDF** (no browser engine on the server). **No deployment** (not pushed).
- **Demo database safety:** scripts that modify data refuse any database whose name does not end in `_demo`. `demo` runs without Gemini keys unless `--live`.
- **Reset restores the finished demo state** (a snapshot taken by `demo:snapshot`), not Phase 1's raw copy, because a raw copy would lose the speakers and summaries made tonight.

## 32. Independent code review of the overnight work (8 Oct, 05:00)

Two read-only review agents went through the public endpoints and edit safety, and through pipeline correctness (about 20 findings between them; nothing was run by them).
Fixed, each with a regression test:
- A guest could send absurd `startSample` / `firstSampleServerMs` values that size arrays in the worker and fail every phone's audio: both are now bounded (6 h of samples; the clock estimate must be within 10 minutes of Start), and the worker clamps the offset to ±1 h.
- A guest-supplied part `url` was fetched by the worker: it must now be https, contain the part's `publicId`, and (when Cloudinary is configured) sit under the account's path.
- `usePersonId` was unvalidated (a non-id made a meeting permanently return errors; another workspace's person id could be merged into): it must now be an id of a person in the same workspace, and `mergePeople` refuses cross-workspace merges.
- Split ids could repeat after a merge; cards could be written back stale after a merge; deleting a person left cards pointing at nothing. All fixed.
- `finish` could run twice (two meetings, two jobs): the session is claimed atomically first. Signatures and parts are refused after combining starts; a room is capped at 30 phones; every guest call is throttled per address and code; the join limit is 100 a minute because a room shares one address.
- A network error in `diarize` was treated as "pyannote unavailable" and dropped the voices: only pyannote's own refusals fall back now; everything else retries first.
- A stored pyannote result without usable output crashed assembly: now ignored. A text-linked rebuild no longer leaves a stale `phase1`. Diarization state is set before chunk jobs are queued. `identify` cannot fail the meeting through naming. The alignment reference is the phone that heard the most speech. A phone's start time can be derived from any of its parts, not only part 0. Control characters can no longer corrupt the Word export. A quadratic scan in the word-speaker fill is linear.

Known and left (also in the handover): "Move this line" / "different person from here on" act on whole turns, so on a very long turn (> 45 s, shown as several lines) they move more than the chosen line;
deleting a group-recorded meeting does not yet remove the phones' raw parts or session records; the insights page shows the global spend ledger and Gemini quota state (fine with one workspace);
two edits made at the same moment in two tabs can overwrite each other; the mix holds every phone's timeline in memory.
