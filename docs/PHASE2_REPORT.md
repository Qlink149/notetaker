# Phase 2 report: speaker identity

_Status: measured where it can be measured without a human. The blind audit and the true speaker counts need Yogansh; those rows say so._

## 1. Stage A: pyannote as the speaker and time base

Every meeting's original recording → 16 kHz mono FLAC (Phase 1's `toAnalysisFlac`) → pyannote media upload → diarize with
`exclusive: true` and `turnLevelConfidence: true` (`confidence: true` on precision-2 only; it is not offered on precision-3).
Speaker count left to the model. Raw output of every job is stored in `p2_pyannote_responses` (results expire after 24 h).
Each job finished in 26–70 s. Gemini calls: 0.

| Meeting | Model | pyannote speakers | Phase 1 Gemini speakers | Speech s | Overlapped speech | Segments | Median seg s | P90 seg s | Speech with turn confidence < 60 |
|---|---|---|---|---|---|---|---|---|---|
| 200 | precision-2 | 4 | 11 | 1565.6 | 10.7 % | 784 | 1.04 | 5.46 | 2.8 % |
| 200 | precision-3 | 4 | 11 | 1580.1 | 11.0 % | 785 | 1.10 | 5.78 | 3.0 % |
| 21-9 | precision-2 | 5 | 11 | 2036.3 | 10.8 % | 1348 | 1.12 | 4.04 | 0.9 % |
| 21-9 | precision-3 | 5 | 11 | 2078.9 | 14.0 % | 1700 | 0.82 | 3.44 | 3.2 % |
| AOM | precision-2 | 7 | 18 | 1626.9 | 1.2 % | 444 | 2.26 | 8.72 | 0.8 % |
| AOM | precision-3 | 7 | 18 | 1571.3 | 1.1 % | 600 | 1.86 | 5.40 | 1.1 % |
| Prachar | precision-2 | 7 | pending | 1938.7 | 14.9 % | 1053 | 0.86 | 4.98 | 1.8 % |
| Prachar | precision-3 | 6 | pending | 1934.0 | 15.2 % | 1235 | 0.78 | 4.54 | 3.9 % |

pyannote's turn-level confidence is capped at 90, so a median says nothing; the last column is the share of speech whose own-speaker confidence is below 60.

**Model pin: `precision-2`** (demo-build decision 1). The two models agree on three of four meetings (they differ by one speaker on Prachar), precision-2 has fewer low-confidence segments, and it is the only one that offers the frame-level `confidence` curve. The pin is cheap to change until the client's real voiceprints exist, because voiceprints only work with the model that made them.

**True counts:** not known yet. pyannote's 4–7 speakers per meeting against Gemini's 11–18 is a large change, but "within ±1 of the true count" can only be judged once Yogansh names the voices.

## 2. Stage B: how Gemini's words are joined to pyannote's speakers

Two methods were built and measured; M2 and M4 were skipped to protect Gemini quota (decision 2).

- **M1, time overlap.** Each Gemini turn takes the pyannote speaker with the most overlapping speech; a turn is split where pyannote changes speaker, only if both sides last ≥ 1.5 s.
- **M3, word clock.** Deepgram nova-3 gives every word a real time (one request per meeting, `hi`; `gu` for "200"). Each Deepgram word takes the pyannote speaker at its midpoint. Gemini's native-script words are aligned to Deepgram's words (semi-global sequence alignment in blocks); matched words copy time and speaker, the rest take their neighbours'.
- **Chooser:** M3 for a chunk when Deepgram's words cover ≥ 70 % of that chunk's speech, else M1. Where they disagree M3 wins.

| Meeting | Speakers M1 / M3 | Coverage M3 (Phase 1) | Gemini words matched to a Deepgram word | M1 vs M3 agreement (share of words given the same speaker) |
|---|---|---|---|---|
| 21-9 | 6 / 5 | 0.985 (0.963) | 4583 / 7748 (59 %) | 0.64 |
| 200 | 4 / 4 | 0.992 (0.992) | 2253 / 4843 (47 %) | 0.75 |
| AOM | 7 / 7 | 1.000 (0.916) | 4046 / 5852 (69 %) | 0.84 |

An alignment bug found on the way is worth recording: the first version aligned end to end against a Deepgram window longer than the block, which rewarded dragging Gemini words onto later Deepgram words; coverage on 21-9 fell to 0.914 and 185 s of speech was left without a turn. Letting unused Deepgram words at either end cost nothing fixed it (DECISIONS #28).

**Audit.** `/audit` is built and seeded (30 items per meeting: 15 M1, 15 M3, a third under 3 s, method hidden, shuffled). **No audit result exists yet.** Agreement between methods is not accuracy. The decision rule from the brief applies once Yogansh has judged the lines: highest "speaker right" rate wins; within 3 points prefer the method with fewer Gemini calls that leaves Gemini's text unchanged (both do); below 85 % stop and investigate.

## 3. Stage C: who is who, across meetings

Voiceprints are made from pyannote's own segments (single speaker, no overlapped speech, 10–30 s, best turn confidence, up to three per voice from different parts of the meeting, never under 6 s). Ten voiceprints were made for the four voices of 21-9 (Speaker A 3, B 3, C 1, D 3; Speaker E has no clean 6 s stretch). Each later meeting was sent to pyannote `identify` with those ten voiceprints.

**Scores** (pyannote's own per-speaker aggregate, 0–100). The first version averaged per-segment scores by duration and diluted a real 78 to 59.6; it is kept only as a fallback.

| Link | Score | Margin over runner-up |
|---|---|---|
| AOM Speaker B = 21/9 Speaker D | 78 | 11 |
| 200 Speaker B = 21/9 Speaker D | 85 | 47 |
| Prachar Speaker D = 21/9 Speaker B | 90 | 62 |

Every non-match scored 16–48 (21 speakers across the three runs; median about 29). Matches scored 78–90. The gap between 48 and 78 is wide, so the overnight thresholds (accept at ≥ 60 with a margin ≥ 10) are not sensitive to their exact values. AOM's link is the weakest: the same voice scored 67 against a second 21-9 person, so it should be confirmed by ear. Thresholds are to be re-calibrated on audited data.

**Blocker:** pyannote returned `402 Insufficient credits and no active subscription` during the third voiceprint batch. The 8 diarizations, 10 voiceprints and 3 identify jobs had completed. Voices of AOM, Prachar and 200 therefore exist as anonymous people with sample clips but **no voiceprints yet**; until a top-up only 21-9's four voices can be recognised elsewhere. `npm run p2:identity -w @meetingid/api -- AOM Prachar 200` (no `--submit` needed for voiceprints) enrols them and is safe to repeat.

## 4. Acceptance items

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Speakers per meeting within ±1 of the true count | **Not judged** | pyannote finds 5 / 4 / 7 (Prachar 7); true counts needed |
| 2 | Blind audit: ≥ 90 % of sampled lines under the right speaker, ≤ 5 % under a wrong named person | **Not judged** | audit page built and seeded; needs the auditor |
| 3 | Naming 21/9's speakers recognises that person in AOM and Prachar | **Partly** | 21/9 Speaker D is linked to AOM and 200 (78, 85); 21/9 Speaker B to Prachar (90). Which of them is Ghanshyam Dholakia must be confirmed by ear |
| 4 | Rename, merge, split, reassign one line; confirmations improve recognition | **Done, except the voiceprint part** | `speakers-review.test.ts` (10 tests) and the rehearsal on real data. A confirmed name gains a voiceprint only when pyannote has credit |
| 5 | Lines ≤ 45 s, both scripts intact, coverage not lower than Phase 1 | **Done** | coverage 0.985 / 0.992 / 1.000 against 0.963 / 0.992 / 0.916; `demo:check` verifies the 45 s limit on every line |
| 6 | Lint, typecheck, tests pass; report with measured numbers | **Done** | see section 6 |

## 5. Cost and spend

- **Gemini:** 0 new calls in Phase 2. Everything used stored output and cleaned turns.
- **Deepgram:** 4 whole-file requests (one per meeting, 21-9, 200, AOM, Prachar), about 2.5 h of audio; at the Phase 1 rate of $0.0043 per minute that is about $0.65.
- **pyannote:** 8 diarize jobs (about 5.0 h of audio), 10 voiceprint jobs, 3 identify jobs (one per later meeting). **pyannote publishes no per-hour rate**: its plans are Developer €19 and Starter €99 per month, each with the same amount of usage credit. The cost per processed hour must be read from the credit balance in the pyannote billing page before and after a run; the dashboard shows hours diarized to divide by.

## 6. Tests

- `packages/pipeline`: 180 tests, including join methods (speaker change mid-turn, overlap, drifted times, words outside any segment), name resolution (two voices claiming one person, margin failure, no voiceprints, several voiceprints), clip selection, loose duplicate names, audit sampling and tally, and the multi-phone signal code (offsets of 0.3 s, 4 s and 20 s found within 50 ms; 0.1 % clock drift recovered and removed; best-channel mix; attribution).
- `apps/web`: 21 tests render the real components in a simulated browser with the API mocked: speaker cards (match, where else heard, closest phone, name, near-duplicate prompt, merge, re-identify failure), transcript line editing, the blind audit (method never shown), insights, the host panel (waits for uploads), the phone's join page end to end, the meeting page after naming, and the routing (join page public, everything else behind the access code). They caught one crash in the host panel that lint and the build had passed.
- `apps/api`: 71 tests, including the pipeline with pyannote mocked (diarize beside transcription, expired result resubmitted, a job older than 24 h resubmitted, rate limit retried, 402 falls back to Phase 1's text linking), speaker review edits, the audit, the Word export (unzipped and inspected), the dashboard, and the multi-phone flow end to end with three synthetic phones.
- Lint, typecheck and tests pass at the commit that carries this report.

## 7. Known defects

See `docs/DEMO_HANDOVER.md` section 7 (ranked by chance of appearing in a demo) and `docs/PHASE3_NOTES.md`, `docs/PHASE4_NOTES.md`.
