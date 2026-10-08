# Demo handover (overnight build, 8 Oct)

Everything is committed locally on branch `phase-2-speaker-identity` in the worktree `c:\Users\pc\Desktop\clara\meetingid-phase2`. Nothing was pushed (you asked me not to), so there is no deployment: the demo runs on this computer.

## 1. Status

| Block | State | Evidence |
|---|---|---|
| 1. Join Gemini text to pyannote speakers (M1, M3, chooser) | **Done** | `docs/PHASE2_REPORT.md` §2: speakers 11/11/18 → 5/4/7; coverage 0.985 / 0.992 / 1.000 (Phase 1: 0.963 / 0.992 / 0.916) |
| 1. `/audit` page, seeded | **Done, not yet used** | 30 items per meeting (15 per method, method hidden). No audit result yet |
| 2. Voiceprints and cross-meeting identity | **Partial** | 10 voiceprints for 21-9's four voices; 3 cross-meeting links (scores 78, 85, 90; non-matches 16–48). **pyannote refuses new voiceprints** (the free trial seems to allow 10, and exactly 10 were made; diarization and identification still work), so voices of AOM, Prachar and 200 have no voiceprints yet |
| 2. Review screen (name, merge, split, reassign, re-identify, duplicate-name check) | **Done** | 10 API tests plus a rehearsal on real data; naming one voice renamed it in 3 meetings |
| 3. Pipeline stages (`diarize` beside `transcribe`, join at assembly, `identify`, text fallback, expired results resubmitted) | **Done** | `test/pipeline-speakers.test.ts` (pyannote mocked). Three meetings reprocessed from stored output with **0 Gemini calls** |
| 3. Key hashes replaced by labels | **Done** | migration applied to the demo database; old hash ids still readable |
| 4. Group recording from several phones | **Prototype** | tested with synthetic tracks only; see §2 |
| 5a. Deploy | **Skipped** | you asked me not to push |
| 5b. Local demo setup | **Done** | `npm run demo`, `demo:tunnel`, `demo:check` (11/11 pass, also through the https tunnel), `demo:snapshot`, `demo:reset` |
| Phase 4: Word export (embedded fonts), cost and quality page, login limits | **Done** | export file inspected in a test; dashboard test; expired/forged tokens rejected |
| Web screens | **Tested in a simulated browser, not looked at** | 21 tests render and drive the speaker cards, transcript editing, audit, insights, host panel, the phone's join page (join → record → upload → finish), the meeting page and the login wall. They found and fixed one crash (host panel) |
| Phase 4: PDF | **Unchanged** | browser print-to-PDF; no browser engine is bundled on the server |

## 2. What is real, what is a prototype, what is not built

**Real (measured or tested):**
- Speakers come from the audio, not from guessing between chunks. pyannote hears each whole recording, so one voice keeps one label. A meeting that used to show 11–18 "speakers" now shows 4–7.
- Words and times are joined to those speakers with measured coverage at or above Phase 1's. Every line is 45 s or less and keeps both scripts.
- A voice recognised in another meeting is shown as the same voice, with a score, and **naming it once renames it everywhere**. This is demonstrated on real data (21/9, AOM, 200).
- Fixing mistakes: rename, "same person as", split a person from a line onward, move one line. Lines re-merge after each change. A near-duplicate name ("Ghanshyam Dholkia") asks "same person?".
- Word export with the Gujarati and Devanagari fonts inside the file; a cost and quality page; summaries written against the new names (by the test summary service, see §7).

**Prototype (labelled "Prototype" in the app):**
- **Group recording from several phones**: QR code and six-letter code, a join page without login, rolling upload, server-side alignment and a best-microphone mix, plus "closest phone" shown beside the voice match. It is **tested with synthetic tracks, not yet with real phones.** What was checked: three synthetic phones through the real routes and worker (alignment within 50 ms, drift recovered), and three phones cut from the real 21/9 recording (offsets within 8 ms, a 0.1 % clock error recovered, a mix with no bad samples). What was not: any real phone, real network, a locked screen, iOS Safari.

**Not built / not done:**
- Deployment (not pushed). Webhooks. A new login system.
- Voiceprints for AOM, Prachar and 200 voices (pyannote refuses new voiceprints on the current plan, see "Needs Yogansh").
- The **blind audit result**: accuracy of the speaker labels has not been measured by a person. Everything above about speakers is "how many" and "linked", not "how right".
- Names. Every voice is "Speaker A, B…" until you name it.

## 3. How to run it

All commands from `c:\Users\pc\Desktop\clara\meetingid-phase2`.

| What | Command |
|---|---|
| Start the demo (API + worker + web, **Gemini switched off** so nothing can spend quota) | `npm run demo` → open http://localhost:5173 |
| Same, with Gemini on (needed to transcribe a *new* recording) | `npm run demo:live` |
| https address for phones | in a second terminal `npm run demo:tunnel`; put the address it prints into "Address phones should open" on the Record page |
| Check the running demo (11 checks) | `npm run demo:check` (add `-- --base <https address>` to check through the tunnel) |
| Back to the saved demo state | `npm run demo:reset` |
| Save the current state as the demo state | `npm run demo:snapshot` |

- **Login code:** the value of `WORKSPACE_ACCESS_CODE` in `c:\Users\pc\Desktop\clara\meetingid-phase2\.env`.
- **Data:** the database `meetingid_demo` (a copy). The Phase 1 database is untouched. The other session's worker was never stopped or written to.
- Ports 8080 (API) and 5173 (web) must be free. No demo process is left running by me.
- localtunnel may show a "tunnel reminder" page once per phone asking for a password: it is this computer's public IP address (`npm run demo:tunnel` prints it). The tunnel is public while it runs: close it when you are done.
- `.env` in the worktree has `ANTHROPIC_API_KEY` removed and `SUMMARY_PROVIDER=handoff`.

## 4. Ten-minute demo script

Before the client arrives: `npm run demo:reset`, `npm run demo`, `npm run demo:check`. **Listen to the speaker samples first** (below) and decide what to call the voices.

1. **(1 min) Meetings.** Open "Meeting 21/9". Point out "98 % of speech transcribed" and the summary.
2. **(2 min) Speakers.** Scroll to *Speakers (5)*. "Before, this recording showed 11 speakers; it has 5 voices." Play the three samples on **Speaker D**. Read the line *"Also heard in 200 as Speaker B (85) and AOM as Speaker B (78)"*. Say plainly: "This is the computer comparing voices; the score is how sure it is."
3. **(2 min) The headline.** Open the AOM and 200 meetings in two other tabs and note their *Speaker B*. Back in 21/9, type the person's name into Speaker D's box (use the name you have verified by ear; example in this script: *Ghanshyam Dholakia*) → **Save**. It says "Also updated in 2 other meetings". Reload the other tabs: the transcript lines and speaker cards now show the name.
4. **(1 min) Duplicate check.** On another voice type a near-duplicate ("Ghanshyam Dholkia"): it asks "looks like someone you already have, same person?".
5. **(1 min) Fixing a line.** Click a speaker's name on a transcript line → "Move this line to…" (or "This is a different person from here on"). The lines re-merge.
6. **(1 min) Word export.** Press **Word** above the transcript; open the file: Gujarati and Devanagari display correctly even where those fonts are not installed.
7. **(1 min) Insights page.** Cost, coverage, how many speakers were checked by voice.
8. **(1 min, optional) Group recording.** Record page → *Start a group recording* → show the QR and code. If the tunnel and two phones are ready, join, press Start, talk, Stop, *Combine and process*. If not, say "prototype, tested with synthetic tracks" and show the page only.

**What not to click:**
- **Re-identify speakers**: it re-runs the comparison with today's voiceprints (identification still works, so it should answer "nothing changed" for a meeting already checked); it cannot add new voiceprints. Not a demo moment.
- **Refresh summary** after naming: it needs the summary service (a person answers it in testing), so the meeting would sit on "Processing" until someone answers. The page tells the truth: "the summary was written with the earlier speaker labels".
- **Retry** buttons, and **recording a new meeting** in safe mode: both need Gemini. Use `npm run demo:live` if you want a new recording transcribed.
- **Audit page** with a client: it is your work tool.

## 5. Morning checklist (08:00–10:00)

1. **pyannote voiceprints** (see "Needs Yogansh"). Without more voiceprints the demo still works as above.
2. `npm run demo:reset`, `npm run demo`, `npm run demo:check`. Click through the script once yourself: nobody has looked at the screens in a real browser (see §7).
3. **Name the voices** (listen to the samples on each Speakers card). This is the ground truth the audit and the "true count" need.
4. **Blind audit, about 25 minutes**: http://localhost:5173/audit. Name each voice from its three samples, then judge the lines; keys R / W / U for the speaker and 1 / 2 / 3 for the text. *Results* tab shows the two methods side by side.
5. **Two-phone test (10 minutes):** laptop + one phone (+ a second if you have one). `npm run demo:live` is not needed to test the join. `npm run demo:tunnel`, enter the https address on the Record page, scan the QR with the phone, allow the microphone, press Start, talk for a minute, Stop, wait for the phone to say "Done", *Combine and process*. **Success:** the host list shows the phone's level moving, each phone shows parts uploaded, the result panel lists each phone ("aligned (shift … clock drift … ppm)") and a meeting appears. **Failure looks like:** the phone never leaves "Waiting for the host" (the https address is wrong or blocked), the microphone level stays flat (permission, or another app has the microphone), "N uploading" never reaches 0 (connection), or the combined meeting says "aligned by timestamps only" (the phones heard too little in common).

## 6. Numbers

| | 21/9 | 200 | AOM | Prachar |
|---|---|---|---|---|
| Speakers before (Phase 1, by text) | 11 | 11 | 18 | not measured (transcript finished after the comparison) |
| Speakers after (pyannote, precision-2) | 5 | 4 | 7 | 7 |
| Coverage after (Phase 1) | 0.985 (0.963) | 0.992 (0.992) | 1.000 (0.916) | 0.982 (0.981) |
| Gemini words matched to Deepgram words | 59 % | 47 % | 69 % | 40 % (Deepgram heard it less: 3 of 4 chunks use M1) |
| M1 vs M3 agreement | 0.64 | 0.75 | 0.84 | 0.69 |
| Linked to another meeting | D ↔ AOM B (78), 200 B (85); B ↔ Prachar D (90) | B ↔ 21/9 D (85) | B ↔ 21/9 D (78) | D ↔ 21/9 B (90) |

- Scores of voices that were *not* the same person: 16–48.
- **Spend tonight:** Gemini new calls **0** (budget 6). pyannote: 8 diarizations (about 5 h of audio), 10 voiceprints, 3 identifications (budget: 3 full-meeting jobs). Deepgram: 4 whole-file requests (budget 6), about $0.62. Summaries: 3, by a subagent, no Anthropic API.
- Tests: 180 (pipeline) + 77 (API) + 21 (web); lint and typecheck clean. Details in `docs/PHASE2_REPORT.md` §6.

## 7. Known defects and risks, most likely first

1. **Transcripts are the Phase 1 ones from before its gap-fill step.** The other session's queue restarted at 05:30 and finished Prachar's transcription, which I took (4 of 4 chunks); its gap-fill (re-listening to speech Gemini skipped) was still queued, so 21/9, AOM and Prachar do not include it. Coverage is already 0.98–1.0 so little is missing; to include it later run `npm run demo:refresh -- <names> --apply` and the steps in `docs/RUNBOOK.md` (new summaries need answering again).
2. **I could not open a real browser, so nobody has looked at the screens.** Their behaviour is tested (21 tests drive them in a simulated browser, and `demo:check` walks the same endpoints a browser uses) but layout, spacing and phone-sized views are unseen. Click through once before the client does.
3. **Some voice links are only as sure as their score.** AOM Speaker B = 21/9 Speaker D is 78, and the same voice scored 67 against 21/9 Speaker B (margin 11). Confirm by ear before naming. Small voices (E/F/G, under a minute) may be fragments of someone else; *Same person as…* merges them.
4. **After naming, the summary text still has the old labels** until someone answers the summary request (testing setup). The page says so.
5. **New voiceprints cannot be created** until pyannote allows more (diarization and identification still work, so a new meeting still gets its voices counted and compared with the existing ten voiceprints).
6. **Group recording on real phones is unproven**: screen lock and background throttling (a phone that sleeps stops recording), iOS Safari, a weak connection, microphone permission prompts, the tunnel's reminder page. The join page asks for a screen wake lock and saves the unfinished part locally every 2 s so a reload recovers most of it.
7. **Gemini's text is unchanged**: names and Gujarati words can still be wrong, and 41–53 % of Gemini's words in 200 and 21/9 are not matched to a Deepgram word (their time and speaker come from neighbours).
8. **Long group recordings use a lot of memory** (about 230 MB per phone per hour while mixing); fine for the demo, not for a long meeting on a small server.
9. Pronouns and names in summaries come from a small model with no checking beyond the format.
10. Left after an independent code review (DECISIONS #32 lists what was fixed): moving one line, or splitting a person from a line, acts on whole turns, so on a very long turn (over 45 s, shown as several lines) it moves more than the line you chose; two edits in two tabs at once can overwrite each other; deleting a group-recorded meeting leaves the phones' raw parts in storage.

## 8. Needs Yogansh

- **pyannote plan**: `POST /v1/voiceprint` returns `402 Insufficient credits and no active subscription` while `/v1/diarize` and `/v1/identify` are accepted. That fits the free trial's 10-voiceprint allowance (checked 8 Oct, 12:50). Subscribe to a paid plan (Developer is €19 a month with €19 of usage credit) in the pyannote billing page, then run `npm run p2:identity -w @meetingid/api -- AOM Prachar 200` to create the missing voiceprints (safe to repeat). Published prices are in `docs/DECISIONS.md` #33.
- **True speaker counts and names** for the four recordings, and the blind audit (§5).
- A decision on deployment when you are ready to push (see `docs/PHASE4_NOTES.md`).

## 9. Where to read more

`docs/PHASE2_REPORT.md` (numbers), `docs/DECISIONS.md` #26–#31 (every decision I made on my own, with reasons), `docs/PHASE3_NOTES.md`, `docs/PHASE4_NOTES.md`, `docs/RUNBOOK.md`.

## Hourly progress log

- 02:25 IST: safety setup (Anthropic key removed, worktree on `meetingid_demo`).
- 03:09: join, Deepgram word clocks, identity links, review screen, audit seeded. pyannote stopped accepting new voiceprints (the trial's 10 were used).
- 03:55: pipeline stages with pyannote mocked tests; three meetings reprocessed; summaries answered.
- 04:30: group recording prototype end to end with synthetic phones; Word export; dashboard.
- 05:00: demo launcher, tunnel, smoke check, snapshot and reset verified; this document written.
- 05:30: the other session's queue restarted on the quota reset and finished Prachar's transcription; Prachar joined, reprocessed and summarised (0 Gemini calls by me). Two independent code reviews fixed (DECISIONS #32). Final snapshot taken.
