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
`claude-sonnet-5-5`; it was `claude-haiku-4-5-20251001` until 2026-10-14) can change without a deploy of code.
Why Sonnet: on the same 19-minute transcript with the same instructions, an independent audit found 6 high-severity
errors and 9 of 19 action items wrong with Haiku, against 1 and 2 of 22 with Sonnet (docs/SUMMARY_AUDIT.md). It costs
about twice Haiku per token ($2/$10 vs $1/$5 per million), a few cents more per meeting.

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
  credit, with a 30-day trial. The per-hour rates are on pyannote.ai/pricing (see #33; this entry was wrong when written: the docs pages do not list them, the pricing page does).
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
- **pyannote stopped accepting new voiceprints** (corrected in #33: this is the trial's 10-voiceprint allowance, not all credit) during the third voiceprint batch: `POST /v1/voiceprint` now returns 402
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

## 33. pyannote pricing, checked properly (8 Oct, 12:50)

Sources read: pyannote.ai/pricing, docs.pyannote.ai/administration/billing, pyannote's blog "Build vs. Buy" (list prices as of August 2026), and live probes of the API (free: a request for a file that does not exist cannot succeed, and only jobs that reach `succeeded` are billed).

- **Plans:** Developer €19 / month with €19 of usage credit; Starter €99 / month with €99 of usage credit; Enterprise custom. One-month free trial (no card). Usage beyond the credit is pay-as-you-go at the same rates; a monthly spend limit can be set.
- **Rates, per audio hour (Developer / Starter):** diarization batch €0.112 / €0.096 (the pricing page labels this line "Precision-3"; the blog and a third-party summary call the same figures "Precision-2"; precision-2 and precision-3 may share a price, which I could not confirm); Community-1 €0.035; Live-1 €0.198 / €0.170; speech-to-text orchestration €0.168 / €0.144.
- **Voiceprints:** billed per voiceprint created, not by duration. The price shown is €0.015 (the unit is inferred, the table text does not label it).
- **Identification:** billed by audio duration like diarization. The pricing page lists €0.015 next to it without a clear unit; whether that is per hour or per voiceprint I could not tell. Budget it as anything from €0.015 to €0.112 per audio hour.
- **Billing rules (billing docs):** by audio seconds sent for processing, 20 s minimum per diarize/identify job, only successful jobs are billed.
- **What this means for what happened last night:** the FAQ says the trial includes "150 hours of identification and 10 voiceprints". We made exactly 10 voiceprints, then `/voiceprint` answered 402 while the later identify jobs still succeeded. A probe today confirms it: `/diarize` passes the credit check, `/voiceprint` does not. So pyannote was not out of credit; **the trial's voiceprint allowance was used up.** My earlier statement that the account had no credits was too broad.
- **Estimated use in Phase 2 so far:** 8 diarizations = 4.8 audio hours × €0.112 ≈ €0.53 (if both models are priced alike); 3 identifications = 1.7 hours × €0.015–0.112 ≈ €0.03–0.19; 10 voiceprints × €0.015 = €0.15. About **€0.7–0.9 in total**, inside the trial.
- **Estimated pyannote cost of one 1-hour meeting:** diarization €0.112 + identification €0.015–0.112 + voiceprints (about 3 per new voice, 1 per recognised voice; 5 new voices ≈ €0.23) = roughly **€0.15–0.45, typically about €0.3**. €19 of Developer credit covers roughly 55 such meeting-hours a month, or about 170 hours of diarization alone.
- **Still to confirm with pyannote or the dashboard:** the identification unit price, whether precision-2 is billed like precision-3, and what the Developer plan's overage does after the credit is used.

## 34. The join rebuilt around Deepgram's clock (8 Oct, afternoon)

**What was found.** A listener heard a second, lower voice asking "hoarding kidhar gaya?" inside one line of Prachar (7:41) that showed one speaker. Tracing it through every stored layer showed three separate causes, not one:

1. **Gemini's clock is wrong, often by a lot.** Matching Gemini's words to Deepgram's (which have real word times), Gemini's own turn times are off by seconds to minutes, and not smoothly: in 21-9, 89 of 265 well-matched turns were more than 10 s off and 39 more than 40 s; in AOM one turn was 139 s off; in 200 the offset is about 30 s for a stretch, then jumps to about 0 at a chunk seam. Spot checks confirmed it is real (at Gemini's time Deepgram hears other words; at the aligned time it hears exactly the Gemini text). The old M1 looked up the pyannote speaker at that wrong time, and the old chooser (M3 only if Deepgram covered ≥ 0.70 of a 10-minute chunk) sent whole chunks to M1: Prachar's first chunk scored 0.669.
2. **Few Gemini words could be matched** (40-69 %) because Gemini writes English words in Devanagari ("टीवी, प्रिंट, डिजिटल") where Deepgram writes Latin ("TV print digital"), and digits where Deepgram writes number words. Deepgram also simply misses speech in places (Prachar: 3,570 Deepgram words against 5,897 Gemini words; none at all for about 90 s near 34:00).
3. **Short interjections were smoothed away**, and unmatched words took the speaker of the nearest matched *word* instead of the speaker at their time.

**What was built** (`packages/pipeline/src/join`):
- A **phonetic key** (consonant skeleton, voicing and aspiration folded; प्रिंट = print, डिजिटल = digital, टीवी = TV) so Devanagari and Latin spellings align. Matched words: 59→67 % (21-9), 47→49 % (200), 69→76 % (AOM), 40→44 % (Prachar).
- Unmatched words are timed from Gemini's own pacing shifted by the offset at their matched neighbours, and take the pyannote speaker at that time; between two anchors of the same speaker another voice is believed only for a solid segment (≥ 0.8 s, word at least 0.3 s inside it). Short runs are kept only if anchored by ≥ 2 matched Deepgram words (2 words / 0.4 s), otherwise 3 words / 1.5 s.
- **`joinMeeting` is now word clock first, everywhere** (no per-chunk chooser). A turn with fewer than 4 matched words, or under 30 % of its words matched, keeps **Gemini's turn boundaries** (they mark speaker changes the word clock cannot see) and is joined by time overlap (M1, minimum split 1.0 s) after being **shifted by the drift** interpolated between the nearest dense anchored turns (only if those are at most 80 s apart and agree within 8 s; otherwise its own time is kept and the turn is marked time-estimated).
- **Safeguards found by failures on real data:** a turn's drift counts only from a *dense* match (≥ 3 matched words and ≥ 30 % of its words), because a few common words (aur, yeh, hai) align almost anywhere and a run of such false matches even agrees with its own neighbours (this collapsed 90 s of Prachar into one 82-second block and teleported a turn 92 s); a turn whose drift disagrees with both neighbours and the line between them is rejected, while a real jump at a chunk seam (agrees with one side) and a steep ramp (agrees with the line) are kept.
- The installed join gate is now "coverage not more than 3 points below Phase 1" (was 0.2). Phase 1's coverage counts a turn at the wrong time as covering the speech near it, so a join that puts text at its true time can legitimately score a little lower.

**How it was measured** (`npm run p2:holdout`, `npm run p2:joincheck`; no engine calls). Hide every third block of Deepgram words, join again, and compare the hidden words with what the full run knew:

| | 10 s holes (mean of 4) | 60 s holes (mean of 4) |
|---|---|---|
| old M1 on Gemini's times | 79.7 % speaker right | 79.4 % |
| word clock only | 86.7 % | 59.9 % (it collapses in long holes) |
| **final rule** | **89.4 %** | **83.3 %** |

Time error of a hidden word (median): Gemini as it is 1.0-7.3 s (p90 up to 49 s), word clock 1.0-1.3 s (24 s in 60 s holes), Gemini plus the measured drift 0.8-1.7 s. On the stored joins: Deepgram words found in the line text at their time rose from 22 / 29 / 37 / 53 % (M1) to 40 / 35 / 53 / 55 % on 21-9 / 200 / AOM / Prachar; Deepgram words under a different speaker than pyannote heard fell from 9.6 / 6.8 / 0.8 / 6.8 % to 3.7 / 4.4 / 0.4 / 3.6 %; no words are lost or duplicated.

**What this does not prove.** "Right" here means "the speaker pyannote gave at the Deepgram word's time", so a pyannote mistake is invisible to every number above. Only a listener can say how many speakers there really are and who said what; the blind audit at `/audit` is still the real test. Roman/native splitting was checked and is fine (word counts equal in 92-99 % of turns, proportional cuts within one word of a phonetic alignment in 97-100 %).

**Known limits after this change.** About 3 % (21-9), 4 % (200 and AOM) and 14 % (Prachar) of turn time has no verified time (no dense anchors and no trustworthy drift neighbours): those lines keep Gemini's own time and are marked time-estimated; the web UI does not show that mark yet. 24-83 s of pyannote speech per meeting has no text near it (Gemini omissions; Phase 1's gap-fill is the remedy and is waiting for Gemini quota). Short interjections inside poorly anchored turns are split only if pyannote's segment lasts ≥ 1 s.

## 35. Local speaker embeddings as a second opinion (8 Oct, evening)

Tried two open models through sherpa-onnx on the cached audio (`tools/local-voices`, `npm run p2:localvoices-export`, then `voices.py embed|compare`; no network, no API calls, CPU only, about 1.5 minutes per model for 343 clips from the 23 voices). Clips are single-speaker stretches of 1.5-12 s with no overlap, up to 24 per voice.

- **WeSpeaker ResNet34 (VoxCeleb): not usable on this audio.** The mean cosine between any two clips is 0.70, so a common component dominates; after centring, pyannote-linked voice pairs score higher than other pairs in only 42-59 % of comparisons (chance). The published 0.72 % EER on VoxCeleb1 did not carry over to mono room recordings in Hindi, Gujarati and English.
- **NeMo TitaNet-small: a weak but real signal.** After subtracting the shared mean, pyannote-linked pairs score higher than other cross-meeting pairs in 91-93 % of comparisons (linked mean cosine 0.21-0.35 against about 0 for others; no two voices inside one meeting above 0.35 when centred per meeting, so no sign of a person split in two). 8 linked pairs only.
- **What it means.** It agrees with pyannote's cross-meeting links, which is independent support for them, but the margin is small, "agrees with pyannote" is not "correct", and 1-second interjections are far too short for it. It is not wired into the pipeline. Not a replacement for voiceprints and not a judge for short interjections; the blind audit stays the real test.

## 36. Two join ideas tested and dropped (8 Oct, evening)

Both on stored data only (no engine calls, no database writes).
- **A second alignment pass with a tight window.** After measuring each turn's drift, align again with the Gemini times corrected and the window narrowed from ±75 s to ±30, 15 and 8 s. Matched share and hidden-word speaker accuracy changed by less than ±1 point in every meeting and block size. What limits the matched share is how much of the speech Deepgram hears at all (46-79 % of Gemini's words), not the alignment, so it was not added.
- **Splitting sub-second interjections in turns without anchors.** M1 minimum split 0.4 / 0.6 / 0.8 / 1.0 / 1.5 s scored 88.4 / 88.4 / 88.7 / 89.1 / 88.9 % (10 s holes) and 82.5 / 82.8 / 82.9 / 83.4 / 83.0 % (60 s holes). In a turn Deepgram did not hear, the time estimate is about 1 s off, which is longer than the interjection, so shorter splits cannot be placed reliably. They need Deepgram anchors (then the word clock already splits them) or audio evidence at that moment.

**Addendum (8 Oct, evening): the gate is 5 points, in the pipeline as well as the scripts.** On a new 34-minute recording the pyannote join scored 0.966 coverage against 0.998 for the text-linked turns (a 3.2-point gap) and was refused by the 3-point gate, although it was clearly better on the independent checks (Deepgram words found in the text at their time 43.7 % against 31.5 %; 3 voices where the text linker invented 5). Coverage of the text-linked version is flattering because it keeps Gemini's own times, so the gate is now 5 points; an absolute floor and the independent checks are what to watch (`npm run p2:joincheck`).

## 37. Making it safe for client use: memory, storage, services (12 Oct)

**Found by the client's first long upload.** A 74-minute recording ("Charlesh Lunch") crashed the live combined service about every 11 minutes (Render events: out of memory, 512 Mi limit) and was retried 256 times with no error recorded. Cause measured: the pyannote and Deepgram uploads read the whole file into memory, 510-590 MB for the 127 MB FLAC of a 74-minute recording.

**Changes (all with tests):**
- Uploads are streamed (`lib/fileBody.ts`): +50-150 MB over idle instead of +310-510 MB. A job that was claimed more than `maxAttempts` times (its worker died each time, so no error was ever recorded) now fails with a plain message instead of looping.
- **Measured on the compiled worker, 74 minutes:** 105 MB at start, 272 MB converting and cutting, 377 MB uploading to pyannote and Deepgram, 364 MB calling Gemini; overall 377 MB with no heap cap. Heap caps (256 MB API, 320 MB worker) in the blueprint.
- **Two services of 512 MB** (`render.yaml`): API on the free plan (kept awake by a ping), worker on Starter ($7). Two free services are impossible: 750 free hours per workspace a month in total, workers are not free, free services sleep. `render.paid.yaml` puts the API on Starter too ($14).
- **Backblaze B2 as a storage option** (`STORAGE_PROVIDER=b2`, default stays Cloudinary): presigned PUT from the browser, streamed download in the worker, playback through an HMAC-signed link on our API redirecting to a 6-hour storage link, local 30-second cut for voice samples, folder delete with pagination; meetings stored on Cloudinary keep working (download, delete). Chosen over R2 because it needs no card for the first 10 GB (sources disagree; check at signup) and costs about $6.95 per TB a month. Verified against stand-ins in tests; `npm run storage:b2-setup` and `storage:b2-check` prove it against the real bucket once credentials exist.
- **The frame-by-frame confidence curve is no longer stored** (half of a meeting's database footprint; nothing reads it); `npm run p2:trim-responses` removes it from older replies (dry run: 17.6 MB).
- **Free-tier Gemini keys are kept off client recordings** (`GEMINI_FREE_KEYS`): Google may use free-tier content to improve its products and humans may read it. `GEMINI_API_KEY3` is on the free tier (Gemini's own error says "5 requests per minute on Free Tier").
- A person made from a meeting called "Meeting 8 Oct (WhatsApp audio)" was named "Speaker A (Meeting Meeting)": `shortTitle` now skips a generic first word.
- A free-tier key cannot process a long recording in a day: the 74-minute run hit the daily quota on every key, and Google's high-demand 503s, before transcribing.

**Not done:** switching the live service to the new layout and to B2 (needs a $7 worker, the B2 bucket and keys, and the production database); the blind audit; the voiceprint consent and delete actions; notifications when a meeting finishes.

**Addendum (12 Oct): voice analysis can be re-run, and a meeting says when it was skipped.** The first deploy of the memory fix finished the stuck 74-minute meeting without voice analysis: its diarize job had already been claimed 256 times, so the new retry cap failed it at once and the pipeline fell back to Gemini's text-based speakers ("Speaker 1" to "Speaker 17", no speaker cards) with nothing on the meeting page saying so. Now the meeting page shows "Speakers were guessed from the text, not from voices" with a **Re-run voice analysis** button, and `POST /meetings/:id/retry {stage: "diarize"}` re-queues only the voice analysis (clearing its failed job and parking the meeting at `transcribe`, where assembly waits for both) and rebuilds the transcript, identification and summary when it finishes. Re-running costs about EUR 0.14 (pyannote) plus Deepgram (about $0.35) for 74 minutes.

## 38. A speaker rename updates the existing summary instead of asking for a new one (20 Oct)

**Client request (Heet, 20 Oct):** "Sometimes a new summary isn't needed; the existing summary is correct except for sections where Speaker A was identified and later renamed. A new summary is unnecessary unless required."

**Change.** Every speaker edit ends in `applyNames`, which now follows the new names inside the written summary and action items (`renameInSummary` in `packages/pipeline/src/summaryRename.ts`) instead of only flagging `summaryOutdated`. The summariser is told to use the speaker names exactly as in the transcript, so the summary's names are those of the speaker map it was written with; that map is stored as `Meeting.summaryNames` when the summary is written (older summaries use the map of their time unless already out of date). No Claude call, no cost.

**Not followed in place (marked out of date, the person decides whether to write a new summary):** speakers joined or split, a line moved to another speaker (the line layout changed), two voices ending up with the same name, or an old real name that is also said in the conversation (it may be a person talked about, not the speaker). Completing a name ("Heet" → "Heet Dholakia") is always followed. Action-item owners are structured fields and are renamed even when the text is not. "New summary" stays available on the summary card.

## 39. One meeting from several audio files (20 Oct)

**Client request (Heet, 20 Oct):** a meeting is sometimes recorded in two or three files (the phone stopped, a break); he wants them to become one meeting with one transcript and one summary.

**Change.** The upload page takes up to 5 files picked together (`MAX_AUDIO_PARTS`), put in recording order (oldest first by the file's date) and reorderable before upload. Every file is uploaded into the same meeting folder (`POST /uploads/sign {meetingId}`); the meeting is created with `parts` and a new first stage, `concat` (`07-concat.ts`), converts each file to the 16 kHz mono FLAC the pipeline already uses, joins them in order (`concatFlac`) and stores the result as the meeting's audio (`combined-1.flac`). Each part keeps its file name, duration and start offset (`audio.parts`), and the transcript shows a "Part 2 · file name" divider where each later file starts. From there the meeting runs exactly like a single upload, so nothing downstream changed. A file that cannot be read fails the meeting at "preparing audio" and names the file; Retry re-runs the join. One-file uploads are unchanged (no `concat` stage).

**Why join the audio rather than process each file and merge results:** speakers, voice matching, gap filling and the summary all need the whole conversation; joining first keeps one code path.

## 40. Adding a continuation to a finished meeting; Share and Copy for Claude (20 Oct)

**Client request (Heet, 20 Oct):** a meeting that went on after the recording stopped, or a second sitting later, should be added to the same meeting instead of becoming a new one.

**Change.** "Add a continuation recording" at the bottom of a meeting: the person picks the file(s), reads what will happen and confirms. The files are uploaded into the meeting's folder and `POST /meetings/:id/parts` appends them (the earlier recording becomes part 1; at most 10 files in all; refused while the meeting is processing). The meeting then goes through the join (`concat`) and the normal pipeline again. A continuation is always added at the end.

**What is paid for again, and what is not (`services/continuation.ts`):**
- Transcription: chunks are planned from the start of the recording, so every 10-minute chunk of the earlier audio keeps its position and its transcript; only the last earlier chunk (its end moves) and the new audio are sent to Gemini. A chunk that had been split (Gemini's filter) keeps its finished pieces too, renumbered after the new plan (this also stops a plain retry from paying for a split chunk again).
- Gap fills over the earlier audio are kept, except those within 30 s of its old end.
- Speaker analysis (pyannote), voice identification and Deepgram's word clock run again on the whole recording: pyannote labels voices per run, so the new audio cannot be analysed on its own. About EUR 0.14 and $0.35 per 74 minutes. The old stored results are kept but retagged/marked superseded so they are never reused.
- The summary is written again for the whole meeting.

**Speaker decisions survive the new labels.** Before the old analysis is retired, the decided cards (named, linked, confirmed, hand-edited) and the voices they were made on are saved (`MeetingData.carryOver`). At identification each earlier voice is matched to the new voice that spoke at the same times in the earlier audio (`carrySpeakers`: more than half of each one's speech there, at least 3 s, one to one); a voice with no clear match is identified afresh rather than given a wrong name. People made from this meeting's unnamed voices are parked under `pre:<old label>` and moved to their voice's new label, so a new voice never takes over someone else's profile; a new voice whose label text is already a person's name gets "… 2". Lines moved by hand are not kept (the lines are rebuilt), which the confirmation says.

**Also:** "Share…" (phone share sheet with the Word file, or the text where files cannot be shared: Drive, Claude, WhatsApp, Mail) beside the other exports (a "Copy for Claude" button was removed on 21 Oct: the client wants the transcript in Google Drive, where he uses it with Claude). The analysis copy used for voice clips is now kept per recording, not per meeting, so it can never be the old audio.

## 41. The "Kept" app: tasks from meetings, Today, Team, Search (branch ui-kept, 21 Oct)

**From:** the client's prototype (`kept-mobile.html`) and the call of 20 Oct. Built on the real data instead of the prototype's browser storage and rule-based extraction.

- **Look:** the prototype's palette (lavender paper, ink, indigo), Instrument Serif + Inter, sky-and-mountains art, bottom tab bar Today · Meetings · + · Team · Search, bottom sheets and toasts (`src/kept.css`, `src/lib/kept.js`, `components/kept/`). The shadcn colour variables were re-pointed, so every existing screen takes the new look without being rewritten. Speakers, Settings (and Insights/Benchmark when switched on) open from the profile button on Today.
- **Tasks** (`tasks` collection, `routes/tasks.ts`): title, owner and optional buddy (people in the speaker directory), priority, deadline (a day), open/done, who gave it ("me"), the meeting and the action item it came from. Deleting a meeting deletes its tasks.
- **Suggested tasks = the summary's action items**, not a new model call: owner from the speaker's name (this meeting's voices, then the directory, then a unique first name), deadline read from the words and counted from the meeting's day (`parseDue`: weekdays, "next Tuesday", "kal/parso/aaj tak", "25 Oct", "in 3 days"), priority from urgency words then how soon. Approved or skipped items are remembered per written summary (`taskReview` + `summaryAt`); a new summary offers its items again. No cost.
- **"Me"** is one person per workspace (`PUT /workspace/me`), as agreed: Heet for now. Kept out of workspace settings, which the settings page replaces whole.
- **Search** (`GET /search`): meeting titles, summaries, action items and transcript lines (every word must appear); a transcript hit links to `?t=<seconds>` and the player starts there. Tasks are searched in the browser.
- **WhatsApp:** reminders, nudges and the standup open WhatsApp with the text written (wa.me); nothing is sent automatically yet.
- **Not built:** Microsoft login, automatic WhatsApp/email, live recording and notes, folders.

**Addendum (21 Oct): no "Delegated"; a desktop layout.** The user asked to drop Delegated from Today: Today is only "my tasks" now (Team still shows everyone's work). From 1024 px the app has a desktop layout instead of a stretched phone: a sidebar (New meeting, Today with a count of tasks due or late, Meetings, Team, Search, Speakers, Settings, the profile) replaces the tab bar; Today is two columns (lists left; suggested tasks, New task, done today and recent meetings right); Meetings and Team are card grids; a meeting shows the transcript on the left and the summary, action items, tasks and speakers in a panel on the right that stays in view; sheets open as centred dialogs. Below 1024 px nothing changed. `kept.css` now loads before Tailwind so responsive utility classes can override the Kept components.

## 42. Folders, and "Save to Drive" (21 Oct)

**Client request (call, 20 Oct):** "the final step is transfer to drive… if it is a small file, automatically drive, when I have to manually transfer it", and folders "like… Jolto… internal… consultant". He keeps meetings in Google Drive by folder and works on them with Claude from there. (A "Copy for Claude" button misread this and was removed.)

- **Folders:** a list on the workspace (starts as Jolto, Internal, Consultant; edited in Settings). A meeting's folder is picked on the upload page and changed on the meeting; Meetings filters by folder. An unknown folder is refused.
- **Google Drive:** connected once per workspace in Settings (OAuth, scopes `openid email drive.file`: the app sees only the files and folders it made, nothing else in his Drive; no Google security review needed for this scope). The refresh token is stored encrypted (AES-256-GCM, key derived from `JWT_SECRET`); the OAuth `state` is signed and expires in 15 minutes. Disconnecting revokes the grant. If he removes access in his Google account, the next save says to connect again.
- **Save to Drive** (button only, as agreed): a Google Doc named "YYYY-MM-DD · title" in `MeetingID/<folder>`; pressing it again updates the same Doc and moves it when the meeting changed folder. Drive converts the Word export into the Doc. The content is the Word export for now; the client's own format replaces `services/google/driveDocument.ts` when it arrives.
- **Setup needed before it works:** a Google Cloud OAuth client (Web application) with redirect URI `<PUBLIC_API_URL>/api/v1/integrations/google/callback`, the consent screen published, and `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_API_URL` (and `WEB_APP_URL`) on the API. Without them the app shows the folders but not the Drive controls.
- **Not yet checked against real Google:** that saving again replaces the Doc's content (Drive's conversion on update); the tests use a stand-in for Google.

**Addendum (23 Oct): Today shows two plain lists.** The client wants it simple, so Today's task area is **Current** (every open task of mine, soonest deadline first, no date last) and **Completed** (every finished one, newest first, with the day it was finished; ticking one again moves it back to Current). The earlier Today / Pending / Upcoming split, the small date headings and the "completed today" fold are gone; each row still shows its own deadline ("Today", "2 days late"). The summary card keeps the two counts. Team and the meeting page are unchanged.

**Addendum (23 Oct): Save to Drive connects in the same tap.** If Drive is not connected, or the stored sign-in can no longer be used, "Save to Drive" on the meeting starts Google sign-in itself and comes back to that meeting. The OAuth state (still HMAC, still 15 minutes) also carries the meeting id and the folder that was chosen. The browser is sent only to `/meetings/<that id>?drive=save`, which the page uses once and then removes, so a refresh does not save again. A return that is not that meeting (another site, a protocol-relative URL, a path that climbs out) is refused and never signed. Settings can still connect on its own, with no meeting to return to.

**Addendum (28 Oct): voice samples can be heard (Speakers page).** "Listen to voice samples (N)" under each person lists every sample the app compares new voices with, each with its meeting, where in it (a link to that moment) and its length, and plays that stretch of that meeting's recording (`GET /speakers/:id/samples`; the voiceprint itself is never sent). Why: the client reported one name, "Harshit Google DV360", being identified in most meetings, and a profile cannot be judged by score alone. Its first sample is a voice in a Kisna operations meeting and its second is a Google presenter who introduces himself as Harshit Dhawan in another, so it may hold two different people with the same first name; a wrong sample leaks into every later meeting, and only listening can show it. Not built: removing or moving a single sample (a change to live data, to be done only after someone has listened).

**Addendum (28 Oct): a voice sample can be removed and restored (Speakers page).** Each sample has "Remove"; a dialog names the meeting, time and length and says that future meetings will not be compared with that clip, that names already on past meetings do not change, and that it can be restored. A removed sample stays on the profile, flagged (`removedAt`) and greyed out with "Restore". Why soft: (1) re-creating a deleted sample costs a paid pyannote voiceprint job; (2) the app learns every clip of a voice a person confirmed that the person lacks (job `learnvoice`), so a deleted sample would come back at the next confirmation, whereas a flagged one still counts as "already there"; (3) a sample's label for pyannote is its place in the person's list and earlier identify results keep those labels, so removal must not renumber the others: places are counted with removed samples included and the removed ones are dropped afterwards (`knownVoices`). Optional "also ignore this person's other voices from this meeting" removes their other samples from that meeting and stops learning from it (`ignoreMeetings`, checked inside the write so a learning job already running cannot add one back); it is ticked by default when that meeting's voice was confirmed as this person, because a wrong card there probably means its other clips are wrong too. Samples are named to the browser by a hash (`key`), never by their id (for old recorded samples the id is the voiceprint itself). A person's last sample may be removed, with a warning that they will not be recognised until a new voice is learned. Merging two people keeps removals and ignored meetings. Correcting a voice on the meeting page still removes the old person's clips (`forgetVoice`); this is for a clip that is wrong on a right card, or when the card cannot be found. Not built: moving a sample to another person (needed if a profile holds two real people, e.g. two men called Harshit), purging a voiceprint permanently, and excluding removed samples when old meetings are re-scored from stored results (comes with the re-score work).

**Addendum (28 Oct): one voice per person, and "Change voice" (Speakers page).** The client was confused by a person showing many clips beside a recording they had made of themselves. Now each person has one voice, the only sample new voices are compared with; their other clips are spares, listed under "Change voice (N other clips)" to listen to and swap in (`POST /speakers/:id/samples/:key/main`, stored as `mainSampleId`). Which sample: the one chosen; otherwise the latest recording the person made of themselves; otherwise the first clip that can still be heard (its meeting still exists, or it has its own file) and is at least 15 s; otherwise the first that can be heard; otherwise the first (`mainSample`). The 15 s is not the client's "first clip" taken blindly: replaying every stored identify job with one clip per person (28 Oct, read-only) showed that 25 of 60 people's first clip is under 10 s and such clips rarely match anyone (Parag's 6 s first clip named him in 0 of 6 meetings where all his clips named him in 4). Same replay: wrong names fell (8 to 3 on the voices a person judged, at 75/10) but so did right ones (at 85/15, 44 to 33 of 55 uncorrected automatic names), and Heet's own recording alone scores lower than his meeting clips (named in 9 of 21 meetings at 85, against 16 with all his clips): his swap button is the remedy. A clip learned later is saved as a spare and never replaces the voice in use (a person with no sample yet gets the first as their default, which can still change to a longer one until they choose). A merge keeps the surviving person's voice (pinned before the other's samples join). A voice cannot be removed; swap first, then remove the old one. A removed or unplayable clip cannot be chosen. Label positions are unchanged (a sample is still `<person>-<place in the list>`), so earlier identify results read the same. Not built: the 85 bar is separate and still not pushed; the "two clips agree" check of that work cannot work with one clip and needs re-measuring; learning still creates a paid voiceprint for every new clip, only to keep a spare to swap in (can be stopped if wanted).

**Addendum (30 Oct): assigning a voice to a person (Speakers page), from PR 6, with its faults fixed; switched off until enabled.** Admin controls on the Speakers page: "Assign to" merges a voice (an unnamed one such as "Speaker A (Meeting Post)", or a second profile of the same person) into a saved person, or names it ("Add new"; a name that already exists offers the merge instead). Every past meeting then shows that name, the voice's samples join the person as spares (the person is still compared by one voice, see the 28 Oct addendum), tasks and "This is me" follow, and later meetings recognise the voice as that person. A preview comes first and nothing is written until confirmed. "Mark as left" keeps a person's name on past meetings and stops matching them in new ones; "Mark as back" undoes that. Deleting a voice shows "Unknown speaker" on its past lines (it is not a participant and counts as unknown). The regenerate-summary button asks first (it uses AI credits); "Refresh summary" after a rename does not.

Faults found in the PR and what was done (review of 30 Oct):
- **Startup would have failed on the live database.** The PR declared the speaker name index non-unique while the live database has it unique; Mongo refuses that (IndexKeySpecsConflict) and `connectMongo` waits for `ensureIndexes`, so the API and worker would not have started, and rolling the code back would have hit the same conflict the other way. Nothing needed it (the app refuses a duplicate name anyway), so the index stays unique, and the migration script is removed. Checked by building the indexes on a database that has the live unique index.
- **Undo.** It wrote a copy of the target's profile from before the merge over it, which lost a voice learned since and, with two merges into one person, duplicated or lost samples. Now the undo record names what the merge added (sample ids, alias, ignored meetings, the pin of the person's chosen voice) and undo takes exactly that away; a card, task or "This is me" changed since is left alone; a summary written again since is kept; tasks that followed the summary (moved or dropped) are put back; an older undo is refused while a newer open change touches the same people ("undo that one first"); a rename undo is refused if the name was changed again or the old name was taken. The record is written before the change and a merge that throws is rolled back, so a stop halfway can still be put back. Records are deleted a day after they expire, and when either person is deleted (they hold a copy of the merged voice's voiceprints).
- **Not while a meeting is processed.** Merge, rename, delete and undo are refused (409) while any job other than a benchmark is queued or running: an identify or learn job in flight holds the old people's labels and would write a card for a person who is gone.
- **Access is not a security boundary.** Only the person set as "This is me" when that name is on `SPEAKER_ADMINS` sees the controls, but anyone signed in with the shared access code can set "This is me" (`PUT /workspace/me`). It prevents slips, nothing more; a real gate needs a login per person. Delete and enrol are not gated.
- **Off by default.** `SPEAKER_ASSIGN` must be `true` for the assign, leave, return and undo controls to appear or work; unset or `false` they are hidden and refused (403). Deploying this code therefore changes nothing a client can see except the deleted-voice and regenerate-summary behaviour above.
- Smaller: "parag" can be corrected to "Parag" (only the identical name is refused); the "Unknown speaker" flag no longer hides the label of a voice that is later given a new (unnamed) person.

Rehearsal (30 Oct, on a copy): the profiles and meetings of two real people ("Ghanshyambhai" and "Ghanshyam Dholakia", who are different people and were used only as a test pair) were read from production (read only) into a throwaway database that has the live unique index; merging them and undoing it (with a voice learned in between) gave profiles, cards, line names, speaker maps, summaries, action items, participants, tasks and "This is me" identical to before, and the preview wrote nothing. No merge has been run on live data. Not rehearsed: the web page in a browser.
