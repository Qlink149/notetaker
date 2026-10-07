# Demo handover (overnight build, 8 Oct)

_Written progressively; the final version is rewritten at 07:30 IST._

## Hourly progress log
- 02:25 IST — Safety setup done: `ANTHROPIC_API_KEY` removed from the worktree `.env`; worktree points at database `meetingid_demo`; copy script `npm run demo:copy` populated it from `meetingid` (read-only on the source; `jobs` and worker heartbeats deliberately not copied so no demo worker can spend Gemini quota).

## Budgets tonight
| Resource | Limit | Used |
|---|---|---|
| New Gemini calls | ≤ 6 | 0 |
| Full-meeting pyannote jobs | ≤ 3 | 0 |
| Deepgram jobs | ≤ 6 | 0 |
