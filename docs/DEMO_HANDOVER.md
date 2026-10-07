# Demo handover (overnight build, 8 Oct)

_Written progressively; the final version is rewritten at 07:30 IST._

## Hourly progress log
- 02:25 IST — Safety setup done: `ANTHROPIC_API_KEY` removed from the worktree `.env`; worktree points at database `meetingid_demo`; copy script `npm run demo:copy` populated it from `meetingid` (read-only on the source; `jobs` and worker heartbeats deliberately not copied so no demo worker can spend Gemini quota).

- 03:09 IST — Done: join (M1 + M3 + chooser, measured), Deepgram word clocks for all four meetings, pyannote identity across meetings (3 links), review screen (name / merge / split / reassign / re-identify) with propagation, `/audit` page seeded (30 items per meeting). **Blocker: pyannote credits are exhausted** (402), so voiceprints for AOM / Prachar / 200 speakers cannot be created until a top-up (see Needs Yogansh). Next: pipeline stages (Block 3), then multi-phone prototype.

## Budgets tonight
| Resource | Limit | Used |
|---|---|---|
| New Gemini calls | ≤ 6 | 0 |
| Full-meeting pyannote jobs | ≤ 3 | 3 (identify: AOM, Prachar, 200) |
| Deepgram jobs | ≤ 6 | 4 (one whole-file request per meeting) |
| pyannote voiceprint jobs (short clips) | not capped | 10, then 402 |

## Needs Yogansh
- **pyannote credits**: the account returns `402 Insufficient credits and no active subscription`. Top up or subscribe in the pyannote dashboard, then run `npm run p2:identity -w @meetingid/api -- AOM Prachar 200` to enrol the missing voiceprints (idempotent). To judge cost, read the credit balance / usage in the billing page before and after.
