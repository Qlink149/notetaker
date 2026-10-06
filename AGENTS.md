# MeetingID — agent notes

npm-workspaces monorepo. Base44 is gone; `legacy/base44/` is a read-only reference until Phase 2 ends.

- `packages/shared` — zod schemas + types shared by web, api and worker.
- `packages/pipeline` — pure pipeline logic (chunking, seam merge, speaker linking, lines, coverage,
  repetition, glossary prompt, summary parsing). No I/O. Every function has vitest tests.
- `apps/api` — Node 20 + TypeScript. Two entrypoints: `src/server.ts` (Render web service) and
  `src/worker.ts` (Render background worker). MongoDB is both the database and the job queue.
- `apps/web` — React + Vite (JSX). Talks to the API only through `src/api/client.ts`.

Rules:

- `packages/pipeline` imports nothing from `apps/`; `apps/web` imports only from `packages/shared`.
- No `any` in `packages/*`.
- Before every commit run `npm run lint && npm run typecheck && npm test` at the repo root.
- Secrets live in `.env` at the repo root (see `.env.example`); never print their values.
- `files/` holds client recordings and is gitignored. Never commit audio larger than 3 MB.
- Ideas outside the current phase go in `docs/PHASE2_NOTES.md`, not into code.

See `README.md` for running locally and `docs/` for architecture, decisions and the runbook.
