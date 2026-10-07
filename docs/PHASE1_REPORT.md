# Phase 1 report

Branch `phase-1-gemini-rebuild` · live runs 2026-10-07 against MongoDB Atlas (AWS ap-south-1),
Cloudinary (Free plan), Gemini (two free-tier keys), Deepgram Nova-3 and, for summaries, an
isolated Claude Haiku 4.5 subagent via the summary handoff (no Anthropic API spend; DECISIONS #17).

**Status: three of the four recordings and the benchmark are done; Prachar is 1/4 transcribed and
resumes automatically after the Gemini free-tier reset (23:59 UTC); deployment is prepared but not
done (no git remote yet).**

## What was built (Phase 1 + live-run fixes)

- npm-workspaces monorepo; Base44 removed; React app talks to an Express API; a MongoDB job queue
  drives ingest → transcribe (one job per 10-minute chunk) → assemble → summarise → finalise.
- Gemini transcription with both scripts per turn, glossary in every prompt, coverage gate at 60 %.
- Fixes made because of the live runs (each with tests): Gemini key pool with quota state in Mongo
  and a `gemini-3.5-flash` fallback; `MM:SS.s` timestamps plus overshoot rescale; seam clock
  alignment from shared sentences; containment-based speaker links; noise-floor silence threshold;
  Cloudinary stores only originals; worker survives Atlas DNS blips; Deepgram language from the
  workspace; $5 spending cap; summary handoff for testing.
- 116 automated tests (76 pipeline, 40 API) pass; lint and typecheck clean.

## Acceptance results

### Per recording

| | 21-9-2026 | 200 | AOM part 1 | Prachar | 3-min clip |
|---|---|---|---|---|---|
| Duration | 42.3 min | 32.2 min | 31.8 min | 36.8 min | 3.0 min |
| Chunks | 5 | 4 | 4 | 4 (1 done) | 1 |
| Model used | 3.5-flash (all) | 3.5-flash (all) | 3.5-flash (all) | 3.5-flash | 3.5-flash |
| Retries (why) | 3 chunks ×2–3 (503 overload, fetch failed) | 1 chunk ×2 (503) | none | quota wait | 3.8 timeout → fallback |
| Turns / lines | 546 / 515 | 319 / 284 | 111 / 92 | pending | 18 / 19 |
| Distinct speakers | 11 | 11 | 18 | pending | 2 |
| Words (roman) | 7,769 | 4,819 | 5,727 | pending | 496 |
| Coverage | 0.964 | 0.992 | 0.899 | pending | 1.000 |
| Status / summary | completed / completed | completed / completed | completed / completed | processing | completed / completed |
| Gemini tokens in / out | 69,128 / 64,155 | 52,633 / 42,542 | 52,137 / 25,326 | — | 4,997 / 2,784 |
| Cost at paid prices* | $0.68 | $0.46 | $0.31 | — | $0.04 |
| Actual spend | $0 | $0 | $0 | $0 | $0.006 (Claude API) |
| Transcription wall-clock | 17.7 min | 10.5 min | 5.7 min | — | 5.1 min |

\* gemini-3.5-flash at $1.50 in / $9.00 out per 1M tokens (ai.google.dev/gemini-api/docs/pricing,
read 2026-10-07). Actual Gemini spend is $0 (free tier). Summaries were written by the handoff
subagent, so no Claude API tokens are recorded for the three full meetings.

### Acceptance items

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | 200.mp3: thousands of words, native + roman, or `partial` | **Pass** | 4,819 words (old system: 255), 207 lines in Gujarati script with a roman twin, coverage 0.992, summary written over full coverage. |
| 2 | 21-9 and AOM: one script per view, lines ≤ 45 s, speaker changes mid-sentence → new lines | **Pass, with a minor defect** | Longest line 44.0 s / 44.5 s; 0 lines > 45 s. 73 (21-9) and 7 (AOM) mid-sentence speaker changes start new lines, e.g. "…Kaka, iske alawa" → "Humne last Diwali mein kya diya tha?". Short responses as own lines: `[0:04] Speaker 2: Haan.`, `[0:22] Speaker 3: Ji.` (21-9), `[3:19] Speaker 3: Ji.` (AOM). Defect: 4 of 515 roman lines in 21-9 contain one stray Devanagari word ("chal रहा है"). |
| 3 | Kisna, CaratLane, Tanishq spelled correctly | **Pass** | In transcripts: CaratLane ×8, Tanishq ×10, Kisna ×2 (21-9); Tanishq ×2, Kisna ×2 (200); summaries spell them the same. Pattern search for known misspellings (Kismet, Carat Tlin, tanish, …): none. Not in the glossary yet: the brand "ORA" (heard as "ORA", "Aura", "Evara"). |
| 4 | No `---`, no `ACTION_ITEMS`, no invented identities | **Pass** | All four summaries; action-item owners are only `Speaker N` or `Unassigned`; no `Speaker N (name)`. |
| 5 | Kill the worker mid-transcribe on the 42-min file; no chunk paid twice | **Pass** | First 21-9 run: killed at 11:59:33 with 2 chunks done (30,992 input tokens recorded), chunks 1 and 4 in flight. After restart chunks 1, 3, 4 completed; final 68,948 = 4 × 15,496 + 6,964 — each chunk recorded exactly once. Run completed. |
| 6 | `GET /meetings/:id` < 20 KB during processing | **Pass** | 1,107 bytes while Prachar was processing; 6.2–7.8 KB for completed meetings. |
| 7 | Seam: overlap before/after merge, no duplicate or dropped sentence; label mapping | **Pass for content; speakers still over-counted** | 21-9 chunk 0→1 (drift 0 s, 8 anchors): every overlap sentence appears exactly once after merging; mapping later→earlier `{S1→S2, S2→S3, S3→S1}` agrees with the shared sentences. Measured drift at other seams: +26.4 s and −21.8 s, now corrected before merging. Distinct speakers remain inflated (11–18) because each chunk's own diarization disagrees with its neighbour's (Phase 2). |
| 8 | Repetition / truncation guard | **Not triggered live** | 0 rejected outputs and 0 splits across 19 live chunks. Covered by unit and worker tests only. |

Not yet run: Prachar acceptance (resumes after the quota reset; its summary then needs one more
handoff answer).

## Benchmark (EvalRun `6ac65aaa442271ebdf582f2e`, saved)

| Recording | Engine | Words | Coverage | Wall-clock | Cost (paid prices) |
|---|---|---|---|---|---|
| 21-9-2026 | gemini-3.5-flash | 7,769 | 0.964 | 17.7 min | $0.68 |
| 21-9-2026 | Deepgram Nova-3 (detected hi) | 7,855 | 0.971 | 3.0 min | $0.25 |
| 200 | gemini-3.5-flash | 4,819 | 0.992 | 10.5 min | $0.46 |
| 200 | Deepgram Nova-3 (detected **it**) | **255** | **0.074** | 2.3 min | $0.19 |
| AOM part 1 | gemini-3.5-flash | 5,727 | 0.899 | 5.7 min | $0.31 |
| AOM part 1 | Deepgram Nova-3 (detected hi) | 4,701 | 0.821 | 1.3 min | $0.19 |

Gemini wall-clock includes the 503 retries of a heavily overloaded day; Deepgram priced at
$0.0043/min + $0.0013/min keyterms. `gemini-3.5-transcribe` on 200 failed with
`400 Thinking is not enabled for this model` (not pursued; optional). Prachar not benchmarked yet.

**Recommendation: keep Gemini as the default.** It is the only engine that handled the
Gujarati-heavy recording; Deepgram's language detection chose Italian for it and reproduced the old
system's failure exactly (255 words, ~7 % of the speech). On Hindi, Deepgram matches Gemini's word
count and is 3–6× faster at about half the cost, but it gives no roman twin and lumps speakers into
long lines. **What this does not show:** word accuracy (there is no human reference transcript),
the intended `gemini-3.8-flash` (overloaded all day; every chunk fell back to 3.5), or more than
three recordings. Gemini also silently skipped ~62 s of speech in 21-9 (28 s, 20 s, 14 s gaps) —
inside the coverage gate but real.

### Side-by-side excerpts (same 30 seconds)

#### 200, 5:00–5:30
- **Gemini:** `5:01` Speaker 1: levama to badhee levana badhee. pan aa Surat ma beeju hu em batavavu em? event haaru thaaru beeju batavavu hu? ane aam city, water sports karai naakheesh em. · `5:16` Speaker 3: ke ek aapne, chhe to boat vot ja, i aapne Surat kaik haaree jagahya hoy nyan chaalu karai naakhashu. · `5:22` Speaker 1: water sports, water sports kyan thai shake. kaik kaik nadiee ke em no karee shakie em? · `5:29` Speaker 2: e to varachha paase bandh chhe ne. kyun?
- **Deepgram:** *(nothing)*

#### 200, 20:00–20:30
- **Gemini:** `20:02` Speaker 7: etle lakhnauma na thay, dur thodi thay. 2 acre jagya joie. · `20:07` Speaker 6: e atyare 2 acreno bhav mongho hoy. · `20:14` Speaker 7: ha. 20 lakhni jagyathi, 20 lakh rupiyama vasti rupantar. citythi dur to enu thay bhai … · `20:27` Speaker 6: ha, 20-20 lakhni jagya no male?
- **Deepgram:** *(nothing)*

#### 21-9-2026, 10:00–10:30
- **Gemini:** `10:01` Speaker 2: achha, Get 50% off on diamond value ORA ka. · `10:05` Speaker 1: ji. · `10:06` Speaker 2: aur Tanishq ke up to 20%. normally unka 20% rehta hai kaka … · `10:18` Speaker 1: kuch kuch product mein, kaka. · `10:20` Speaker 2: achha. abhi ye log ka july mein chalta hai uska, july ka kyun nahi aaya?
- **Deepgram:** `9:51` Speaker 2: और यह Silicon Up to है. … CaratLane और Aura का ज़्यादातर diamond prices पर ही रहता है. अच्छा get 50 percent of diamond value. हां. Aura का. जी … (30 s in one line) · `10:19` Speaker 1: अभी यह लोग का July में चलता है उसका. July का क्यों नहीं आया?

#### 21-9-2026, 30:00–30:30
- **Gemini:** *(nothing — part of a 48 s gap)*
- **Deepgram:** `30:05` Speaker 4: यह army वाला है? हां, काका यह army वाला है. … यह एक customer है … जिसने September का offer भी लिया … · `30:26` Speaker 5: उसमें जा रहा है?

#### AOM part 1, 3:00–3:30
- **Gemini:** `3:01` Speaker 2: Haan, to upselling hokar 11 * 15 mein ek hi naam sabhi log chalein … To dedh karod ka sale fix ho gaya. · `3:19` Speaker 3: Ji. · `3:20` Speaker 2: Bahut badhiya, very good, good, good, chaliye. Aur bhi Rajesh, Sheetal bhai kal bata rahe the do-teen point …
- **Deepgram:** `2:49` Speaker 2: Good, बहुत बढ़िया, very good. … ग्यारह into पंद्रह गिनूं sell? … तो डेढ़ करोड़ का sell fix हो गया. जी. बहुत बढ़िया, very good. … (≈40 s in one line)

## Cost and processing time

| Per processed hour of audio | Measured basis | Estimate |
|---|---|---|
| Gemini transcription, gemini-3.5-flash, paid tier | 173,898 in / 132,023 out tokens for 106 min | **$0.82 / h** |
| Same tokens at gemini-3.8-flash prices ($0.75 / $3.75, until 2026-12-31) | | **$0.35 / h** |
| Claude Haiku 4.5 summary | ~13–15k input tokens per 40-min meeting (prompt size) | **≈ $0.03 / h** |
| Deepgram Nova-3 + keyterms (fallback) | $0.0056/min | $0.34 / h |
| Actual spend in this phase | free-tier Gemini, handoff summaries | **$0.006** (clip summary) |

Gemini bills ~26 input tokens per second of audio (15,532 per 10-minute chunk), below the 32/s the
brief assumed. Processing time on 2026-10-07 was 5.7–17.7 minutes of transcription per meeting
(≈ 10–25 min per hour of audio), dominated by 503 "high demand" retries on both Gemini models;
the fallback model answered a 10-minute chunk in 1–6 minutes.

## Departures from the brief

1. `@ffmpeg-installer/*` instead of `ffmpeg-static` (GitHub unreachable at install; #8).
2. No `temperature` on the Gemini Interactions API; fixed `seed` instead, with evidence (#9).
3. Cloudinary stores only the original; chunks are re-cut on demand (Free plan caps raw files at 10 MB; #13).
4. Silence threshold `max(−35 dB, noise floor + 10 dB)` instead of `mean − 18 dB`, which made coverage worse on these files (owner's choice; #14).
5. Several Gemini keys, quota state in Mongo, `gemini-3.5-flash` fallback (#15); `$5` cap (#16).
6. Summaries during acceptance written by an isolated Haiku 4.5 subagent (handoff), not the API (owner's request; #17). The API path is integration-tested only on the 3-minute clip.
7. Timestamps requested as `MM:SS.s` and rescaled on overshoot; chunk clocks aligned at seams (#18, #19).
8. Deepgram language: explicit when the workspace has one language, otherwise per-chunk detection (Nova-3 rejects a restricted list) — not "set from the workspace" in the multi-language case (#20).
9. Workspace is "Kisna" (slug `kisna`); glossary has an `agency` kind for Prachar.
10. Deployment target is one Render Free web service running API + worker (owner's choice; #21).

## Known defects left open

- **Speaker over-counting:** 11–18 distinct "speakers" per meeting; chunk diarizations disagree and
  text at the seam cannot reconcile them. Phase 2 (voiceprints).
- **Speech occasionally skipped:** ~62 s missing in 21-9 (coverage 0.964), ~10 % in AOM (0.899).
- **Stray native words in roman text:** 4 of 515 lines in 21-9.
- **Mixed voices inside one turn:** some long turns contain an exchange between two people
  (e.g. clip 02:39); the model does not always split on a speaker change.
- **`gemini-3.8-flash` unproven:** overloaded or timing out for the whole day; all transcripts are 3.5.
- **`gemini-3.5-transcribe` benchmark adapter** fails with a thinking-config 400.
- **Glossary gap:** "ORA" (competitor brand) heard as Aura/Evara.
- **Free-tier limits:** 20 requests per model per key per day — about 18 chunks (≈ 3 hours of audio)
  per key per day when 3.8 is overloaded, since each chunk then spends a 3.8 request too.

## Questions for Phase 2

1. Speaker naming with voiceprints (the main one): can pyannote voiceprints both name enrolled
   speakers and merge a meeting's per-chunk labels into the true speaker set?
2. Should chunks overlap more than 30 s, or be shorter than 10 minutes, given the 20–26 s clock drift
   measured on gemini-3.5-flash?
3. Is gemini-3.8-flash better than 3.5 on these recordings once it is not overloaded (cost is ~0.4×)?
4. A human reference transcript for 10 minutes of each recording, to measure accuracy instead of word counts.
5. Paid Gemini tier and Starter worker before real client use (free-tier quota and a sleeping Free service are not production).
