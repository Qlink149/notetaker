# Summary audit: what was wrong, what changed, how it was measured (13 Oct 2026)

The summary of "Charlesh Lunch" gave two amounts in rupees that were spoken in dollars. That led to a word-by-word
audit of the summaries of all six meetings. Each summary was checked by an independent reviewer who read the
whole transcript and listed every claim that the transcript does not support.

## How it was measured
- Input and prompt were exported exactly as production builds them (`formatLinesForSummary`, `buildSummarySystemPrompt`).
- The summary was written by an independent model working only from that prompt and transcript (no API key used).
- Another independent reviewer (a stronger model) read the same transcript word by word and wrote a report: every
  issue with a quote and a timestamp, the real decisions and real action items, what was missed.
- Same method for every version, so the counts can be compared. They are rough: reviewers differ a little in strictness,
  and a longer summary has more claims to check.

## What was wrong with the first version (6 meetings, 146 issues, 30 high)
| Problem | Seen in |
|---|---|
| Summary still used "Speaker A..G" because it was written before the voices were named | 5 of 6 |
| Advice, proposals and one person's argument written up as Decisions and action items | all 6 |
| Action item given to the person who spoke the instruction, or to "Unassigned" when the person was named | all 6 |
| Currency or unit wrong or invented (₹ for dollars, crore for lakh, "5.46 lakh discount on a 5 lakh sale") | 4 of 6 |
| Role-played scripts ("sir, I will stay three days") reported as a commitment | 1 |
| Invented insights and open questions (succession, "not reconciled" figures that were one derived from the other) | all 6 |
| A third party's words or offers attributed to the speaker (the $1.8M quote) | 4 of 6 |
| Hindi/Gujarati misread: "tareekh tak" as days, profit as loss, "ja raha hai" (it costs) as a benefit | 3 of 6 |
| The one explicit instruction in a meeting ("Kar lo plan") left out; whole topics missing (fee structure, valuation) | 4 of 6 |
| The meeting split into parts before summarising (over 60,000 characters), losing detail and currency | 1 |

## What changed
- `buildSummarySystemPrompt`: rules for names, attribution, final positions, illustrations, entities, money and
  numbers, Hindi/Gujarati words, and strict definitions of Decisions, Insights, Open Questions and action items
  (tests: `apps/api/test/summaryPrompt.test.ts`).
- Transcripts up to 250,000 characters (more than two hours) go to the model whole; longer ones are noted part by part
  with a prompt that keeps figures, owners and corrections (`SEGMENT_PROMPT`).
- A summary whose speaker names changed afterwards is flagged `summaryOutdated` on the server (the old flag lived in
  one browser tab), shown in the meeting page with a "Refresh summary" button, and cleared when the summary is rewritten.

## Results (issue counts: high / medium / low)
All six meetings, Haiku with romanised text (what production does today):
| Version | High | Medium | Low | Total |
|---|---|---|---|---|
| First (stored) summaries | 30 | 68 | 48 | 146 |
| Rewrite 1 | 12 | 64 | 76 | 152 |
| Rewrite 2 (now in the code) | 15 | 61 | 89 | 165 |

The three hardest meetings (AOM, 21/9, 200 in Gujarati):
| Configuration | High | Medium | Low | Total |
|---|---|---|---|---|
| First (stored) summaries | 13 | 35 | 23 | 71 |
| Rewrite 1, Haiku | 8 | 37 | 41 | 86 |
| Rewrite 2, Haiku | 9 | 34 | 42 | 85 |
| Rewrite 2, Haiku with the original script added | 9 | 40 | 45 | 94 |
| **Rewrite 2, Sonnet with the original script added** | **5** | **25** | **38** | **68** |

Reading it: the rewrite removes the structural mistakes and halves the severe ones, and the summaries are much more
complete. What remains are comprehension slips on Hinglish and Gujarati (reversed arguments, units, who said what).
Adding the original script does not help Haiku. A stronger model does: about 40% fewer high and 25% fewer medium issues.
Sonnet without the original script was not tested.

## The live "Charlesh Lunch" summary
Every automated version still had 1 or 2 high issues on this meeting (the lab-grown venture and the diamond-layout figures
kept being tied to Kisna). The summary now stored was written by hand against the full transcript, then audited twice:
first pass 1 high / 5 medium / 13 low (the high one: a hypothetical about Charles being a Kisna franchisee, removed),
second pass 0 high / 2 medium / 8 low (wording slips, all corrected). The previous stored text and action items are kept
in the working notes of this session; the 4 other meetings with stale labels are flagged `summaryOutdated`.

## Still open
- Remaining errors are mostly attribution and reading Hinglish/Gujarati; the stronger model reduces them (about 40% fewer high, 25% fewer medium) but does not remove them.
- Two lines of the 8 Oct meeting are labelled with the wrong speaker, and some Prachar sentences are split across
  speakers: these come from the speaker join, not from the summary.
- To repeat the test after any prompt change: export the prompt and transcript, have an independent model write the
  summary, have a second one audit it against the transcript, compare counts per severity.
