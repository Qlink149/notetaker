# Speaker identity: issues found on "Charlesh Lunch", fixes, and how they are kept from coming back

Found 13 Oct 2026. The recording has three people (Charles, Ghanshyam Dholakia, Heet). The app showed four
speakers and never named Ghanshyam; he was in the speaker library twice.

## What was checked (and how)
- Text: Charles is addressed as "Charles" and says "Ghanshyam, listen to me…". The voice answering him ("50,000
  Charles") is Ghanshyam. Heet was matched by voiceprint.
- pyannote's own numbers: each segment stores a confidence for every speaker label. Speaker B's segments sound
  like Speaker D at 87 (against 89 for B itself); in 93 % of B's seconds D was within 10 points. Charles scored
  16 against every other voice, Heet 40 or less.
- Re-run with the speaker count given (3): pyannote itself puts B (100 %) and D (93 %) under one speaker.
- Voiceprints on their own against this audio: the AOM-derived voiceprint scored 90 on B and D; the
  "Ghanshyambhai" voiceprint (from Prachar) scored 32, and 54 on Heet, so that voiceprint is not Ghanshyam.

## Issues, fixes, prevention
| # | Issue | Fix | Prevention |
|---|---|---|---|
| 1 | pyannote split one voice into two (B and D). No participant count was given, and when one is given the range was 1 to count+2, too loose to help. | The two voices were merged in this meeting and named Ghanshyam Dholakia (backup of the old data kept). | `speakerCountHint`: a given count now means count-1 to count+1. The upload page asks "How many people speak? (recommended)". |
| 2 | Nothing noticed that two clusters were one voice. | `mergeConfusableSpeakers`: merges two labels when each hears the other within 10 points for 70 % of its time **and** within 5 points for 40 %, and they are never heard at the same moment (3 %). Run once, before cards exist, stored in `speakerMerges`, re-applied (not re-measured) by every later step. | 9 unit tests (including the AOM pair Sheetal/Parag, which must not merge), a pipeline test, and a check over all stored meetings: only this meeting merges. `SPEAKER_AUTOMERGE=false` switches it off. The review screen tells the user when voices were combined. |
| 3 | The second matching cluster became a **new anonymous person** (one-to-one rule said "taken"), with its own voiceprints: Ghanshyam was in the library twice and the library grows with every meeting. | A voice whose best match is already paired with another voice of the meeting is left unlinked, with the closest match shown, instead of creating a person. | Covered by the merge above for split voices; the review screen's merge/name tools handle the rest. |
| 4 | The matched person was an anonymous placeholder ("Speaker A (Meeting AOM)"), shown as "Speaker B". The voice was found (score 90) but never named. | Named: the placeholder is now "Ghanshyam Dholakia" and shows in 21/9, 200, Prachar and Charlesh. | Name a voice once and every meeting with that voice updates (already how renaming works). |
| 5 | "Ghanshyam Dholakia" and "Ghanshyambhai" looked like one person. Tested with stored voiceprints against Prachar, AOM, 200, 21/9 and Charlesh: **two different people**. Same-voice pairs score 86-90 (Charlesh voice vs Prachar 05, vs 200 main, vs 21/9 main); cross pairs score 18, 32, 47, 24. Labels in all five meetings were already right. | Nothing to relabel. | Re-run this cross-check (stored voiceprints vs every meeting) when two people look alike. |
| 6b | One voiceprint (AOM at 6:40, attached to Ghanshyam Dholakia) scored 82-90 on **both** voices, so Prachar's long speaker was flagged for review with the wrong nearest match. | That voiceprint was removed from Dholakia's set (old person data is in the backup). Re-identify still gives 90 (margin 46) in Charlesh and 90 (margin 41) in Prachar. | A voiceprint that matches two voices outside its own meeting is ambiguous: check it before keeping it. Fresh voiceprints could not be made (pyannote said no credits), so Dholakia has 4 voiceprints, all from Charlesh. |
| 6 | The summary still used the old speaker names. | Summary regenerated. | Naming a speaker already reports which meetings changed. |

## Still open
- A wrong merge cannot be undone with one click: use Split on a line (it exists) or switch `SPEAKER_AUTOMERGE` off.
- Merging was tested on 6 recordings only; one real split, no false merge. Watch the "combined automatically" notice.
- precision-3 output (not used by the pipeline) would merge one AOM pair; the pipeline is pinned to precision-2.
