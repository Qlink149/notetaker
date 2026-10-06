# Notes for Phase 2

Things noticed during Phase 1 that are out of its scope.

## Speaker naming (the Phase 2 feature)

- Plug `VoiceprintResolver` into `assembleStage` via `Deps.resolver`. Inputs available: merged
  turns with global labels `S1..Sn`, `meeting.audio.analysisUrl` (16 kHz mono FLAC), lines ≤ 45 s
  (good clip candidates).
- The Base44 `refreshMeetingSpeakers` logic, for reference: run pyannote `identify` with every
  enrolled voiceprint (max 10) or `diarize` when none; poll the job; `resolveSpeakers` (ported in
  `services/pyannote/client.ts`) takes a duration-weighted average confidence per diarization
  speaker and accepts ≥ 50 (pyannote ignores `matching.threshold`; measured 83–89 for enrolled,
  16–36 for others). Each line then adopts the identified name with the best time overlap, only if
  it is a real name. The summary is regenerated only if any line changed.
- The Base44 "relabel unknown speaker" flow used substring replacement on the summary, so renaming
  "Unknown 1" also hit "Unknown 10". Rename by exact label, or re-summarise.
- Auto-enrolment from a meeting picked the speaker's longest merged block (≥ 3 s, cut to 30 s).
  Lines are now ≤ 45 s, which makes clip selection easier.
- Labels for a speaker who is absent from a chunk overlap cannot be linked by text; voiceprints
  would fix the remaining "Speaker 5 is really Speaker 2" splits.
- `expectedParticipants` is stored on each meeting but not used yet; it can cap the number of
  clusters.

## Engines

- Sarvam `saaras:v4` adapter is a stub (`services/engines/sarvam.ts`).
- `gemini-3.5-transcribe` returns a single script; if it wins the benchmark, it needs a romanising
  step or a second call for `text_roman`.
- Deepgram output is not romanised: `textRoman` equals the Devanagari output.

## Frontend

- Many shadcn `components/ui/*` files and their packages (recharts, embla, vaul, cmdk,
  react-day-picker, react-resizable-panels, next-themes, sonner, input-otp, react-hook-form,
  date-fns and most `@radix-ui/*`) are unused and can be pruned.
- Print-to-PDF export is still the browser print dialog (Phase 4 replaces it).

## Platform

- Cloudinary assets for deleted meetings are removed best-effort; a periodic sweep of orphaned
  `workspaces/*/meetings/*` folders would catch failures.
- Old `done`/`failed` job documents accumulate; add a TTL index (e.g. 30 days on `updatedAt` for
  finished jobs).

## Speech detection threshold

`silencedetect noise=-35dB:d=0.8` found no silence at all in `Prachar.mp3` (100 % "speech",
one segment over 36.8 min), while the other three recordings came out at 85–90 %. A noisy
background makes the coverage denominator the whole file and the ratio pessimistic. Option: when
speech exceeds ~97 % in ≤ 2 segments, re-run with a threshold relative to `volumedetect`'s mean
volume (e.g. mean − 10 dB). Decide after seeing real Gemini coverage on that file.
