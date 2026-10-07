# Phase 3 notes: multi-phone capture (prototype built overnight, 8 Oct)

What exists, how it works, what was checked, and what to do next. The whole feature is labelled **Prototype** in the app.

## What was built

- **Session and join** (`apps/api/src/routes/sessions.ts`, `models/session.ts`): the host (logged in) creates a session with a six-character code (no 0/O/1/I/L); guests open `/join/<code>` without logging in and are identified only by a random token returned when they join. Joining is limited to 20 calls a minute per address; joining closes once the host stops.
- **Guest page** (`apps/web/src/pages/Join.jsx`, `lib/phoneRecorder.js`): microphone with **echo cancellation, noise suppression and auto-gain off** (they distort the level differences the mix relies on); audio downsampled to 16 kHz mono and cut into independent **60-second WAV parts** (exact sample count, no gaps, each decodable alone); every part is saved to IndexedDB, uploaded straight to Cloudinary with a signed request, then reported to the API, with retry and back-off; the unfinished part is saved every 2 s; a reload uploads what was left. The phone polls the session every 2 s (starts and stops with the host) and reports its input level.
- **Host panel** (`components/GroupRecording.jsx`): QR code (the `qrcode` package, drawn locally), the code, who has joined with a live level meter, Start, Stop, then *Combine and process* (it waits for every phone to finish uploading unless you choose *Combine anyway*).
- **Worker stage `multitrack`** (`pipeline/stages/05-multitrack.ts` + `packages/pipeline/src/multitrack.ts`):
  1. every phone's parts are placed on the session timeline using the server clock estimate of its first sample (coarse alignment, good to a few hundred ms);
  2. fine alignment against the loudest phone: RMS envelopes at 100 Hz (from 8 kHz audio), normalised cross-correlation per window (5 minutes; shorter recordings get ~6 windows), searching ±20 s, with the correlation taken over the overlapping part only so a phone that started late still aligns;
  3. a straight line `offset(t) = a + b·t` through the windows (outliers ignored) gives the clock drift; the track is re-timed with linear interpolation;
  4. **best-channel mix**: tracks are level-matched (typical speech at −20 dBFS), then for each 250 ms the loudest phone is used (it only switches for a phone ≥ 1.5 dB louder, and not at all during silence), with 20 ms cross-fades. Never a plain sum;
  5. the mix is uploaded as the meeting's recording and the normal pipeline starts; per-phone loudness per 250 ms is stored in `sessionloudness`.
- **Third signal** (`routes/meetingSpeakers.ts`): for each voice, which phone was loudest (level-matched) for most of its segments with ≥ 3 dB lead; shown on the speaker card as "Mostly closest to Anil's phone". It never changes a name and never overrides a voiceprint match.

## What was checked

- Unit tests with synthetic speech-like audio: offsets of 0.3 s, 4 s and 20 s all found within 50 ms; 0.1 % clock drift recovered as a slope of 700–1300 ppm and removed; unrelated audio produces no match; mix follows the nearest phone with few switches and no jumps; attribution abstains on ties and silence.
- End to end through the real routes and worker (`test/multiphone.test.ts`): three synthetic phones starting 0, 2.7 and 11.2 s late, with timestamps deliberately 150–400 ms wrong, gain differences and a 0.1 % slow clock, 60 s parts, wrong-token and wrong-folder uploads refused, session closes to new joiners. Alignment error under 50 ms for all three; meeting completes through the normal pipeline.
- Real speech: `npm run demo:synthetic-phones -- <audio> --from 600 --seconds 180` cuts three phones from the 21/9 recording (start offsets 0 / 2.7 / 11.2 s with timestamps off by +0.2 / −0.3 / +0.25 s, gains 1 / 0.5 / 0.8, a 200 Hz high-pass on one, a 0.1 % faster clock on another): remaining error **0.2 ms and 7.8 ms**, drift recovered as −1013 ppm, mix of 180 s with 6 switches, peak 0.75, no non-finite samples. Nobody has listened to the mix; check `scratch/p2/synthetic-phones/mix.flac` by ear.

## Not checked, and where it could break

- **Any real phone.** Screen lock or backgrounding can stop capture or throttle timers (a wake lock is requested but not guaranteed); iOS Safari's audio-context rules; microphone permission flows; low-end devices running the 4096-sample script processor.
- A real network: large uploads over mobile data, the tunnel's reminder page, https certificate quirks.
- Rooms with echo or one very loud talker (best-channel mixing handles one phone per moment, not overlapping speech).
- Memory: the stage holds every phone's full timeline as 32-bit floats (about 230 MB per phone-hour), plus the aligned copy.
- A phone that joins late or leaves early (handled by the timeline, but untested with real timing).

## Next steps, roughly in order of value

1. A real two- and three-phone trial in a real room; keep the raw parts and check by ear.
2. Estimate each phone's clock offset properly (several round trips, keep the shortest), and send it with every heartbeat; today the first sample's time comes from one lowest-delay sample.
3. Use the phones for **naming**: when each guest joins with their name, the phone that is loudest for a voice is a strong hint of who it is. Offer "Anil's phone → Speaker B?" in the review screen, and enrol a voiceprint from that confirmation.
4. Pass the number of joined phones as `numSpeakers`/`maxSpeakers` hints to pyannote (the stage already sets `expectedParticipants`, and the diarize stage turns it into a speaker range).
5. A service worker for uploads, so they continue when the page is not in front.
6. Stream the mixing (windows instead of whole timelines) for long meetings; consider beam-forming instead of switching if rooms are echoey.
7. Keep per-phone transcripts for the case where the mix hides a quiet voice.
8. Consent: say on the join page that the audio is recorded and who can see it.
