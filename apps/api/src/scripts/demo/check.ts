import { parseArgs } from 'node:util';
import { env } from '../../config/env.js';
import { connectMongo, disconnectMongo } from '../../db/mongo.js';
import { ParticipantModel, SessionModel } from '../../models/session.js';

// Smoke test of a RUNNING demo (npm run demo): logs in and walks the screens' endpoints through the
// same address a phone would use. Exit code 1 if anything fails. It creates one throw-away group
// session ("demo-check") and removes it again.
//   npm run demo:check -w @meetingid/api -- [--base http://localhost:5173]
const results: { name: string; ok: boolean; note: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const note = (await fn()) ?? '';
    results.push({ name, ok: true, note });
  } catch (e) {
    results.push({ name, ok: false, note: e instanceof Error ? e.message : String(e) });
  }
}
const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { base: { type: 'string', default: 'http://localhost:5173' } },
  });
  const base = values.base!.replace(/\/$/, '');
  const api = `${base}/api/v1`;
  const code = process.env.WORKSPACE_ACCESS_CODE;
  need(code, 'WORKSPACE_ACCESS_CODE is not set in .env');
  let token = '';
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        'Bypass-Tunnel-Reminder': '1',
      },
    });
    return res;
  };
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await call(path, init);
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
    return (await res.json()) as T;
  };

  await check('web app is served', async () => {
    const res = await fetch(`${base}/`, { headers: { 'Bypass-Tunnel-Reminder': '1' } });
    need(res.ok && (await res.text()).includes('<div id="root"'), 'no app shell');
  });
  await check('join page route is served (phones open it)', async () => {
    const res = await fetch(`${base}/join/ABC234`, { headers: { 'Bypass-Tunnel-Reminder': '1' } });
    need(res.ok, `status ${res.status}`);
  });
  await check('API health and worker', async () => {
    const h = await json<{
      ok: boolean;
      db: string;
      worker: { lastHeartbeat: string | null };
      engines: Record<string, boolean>;
    }>('/health');
    need(h.ok, 'db down');
    const age = h.worker.lastHeartbeat
      ? (Date.now() - new Date(h.worker.lastHeartbeat).getTime()) / 1000
      : null;
    need(age !== null && age < 90, 'no recent worker heartbeat');
    return `worker heartbeat ${Math.round(age!)} s ago; gemini ${h.engines['gemini'] ? 'ON' : 'off'}, deepgram ${h.engines['deepgram'] ? 'on' : 'off'}`;
  });
  await check('login', async () => {
    const r = await json<{ token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    token = r.token;
  });
  let meetings: { id: string; title: string; status: string }[] = [];
  await check('meetings list', async () => {
    meetings = (await json<{ meetings: typeof meetings }>('/meetings?limit=50')).meetings;
    need(meetings.length >= 3, `only ${meetings.length} meetings`);
    return meetings.map((m) => `${m.title} [${m.status}]`).join('; ');
  });
  for (const m of meetings.filter((x) => x.status === 'completed')) {
    await check(`${m.title}: transcript, speakers, export`, async () => {
      const d = await json<{
        lines: { start: number; end: number; speakerName: string }[];
        speakerMap: Record<string, string>;
      }>(`/meetings/${m.id}/data`);
      need(d.lines.length > 0, 'no lines');
      need(
        d.lines.every((l) => l.end - l.start <= 45.01),
        'a line is longer than 45 s',
      );
      const sp = await json<{
        source: string;
        cards: { clips: unknown[]; displayName: string; match: unknown }[];
      }>(`/meetings/${m.id}/speakers`);
      need(sp.source === 'pyannote', `speakers come from ${sp.source}`);
      need(sp.cards.length > 0, 'no speaker cards');
      const docx = await call(`/meetings/${m.id}/export?format=docx&script=both`);
      const buf = Buffer.from(await docx.arrayBuffer());
      need(
        docx.ok && buf.subarray(0, 2).toString() === 'PK' && buf.length > 100_000,
        `export ${docx.status}, ${buf.length} bytes`,
      );
      const names = [...new Set(d.lines.map((l) => l.speakerName))];
      return `${d.lines.length} lines, ${sp.cards.length} speakers (${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}), ${sp.cards.filter((c) => c.match).length} linked, docx ${Math.round(buf.length / 1024)} KB`;
    });
  }
  await check('audit page data', async () => {
    const l = await json<{ meetings: { id: string; items: number; answered: number }[] }>('/audit');
    need(l.meetings.length > 0, 'no audit meetings');
    const a = await json<{ clusters: unknown[]; items: unknown[] }>(`/audit/${l.meetings[0]!.id}`);
    need(a.items.length > 0 && a.clusters.length > 0, 'empty audit');
    return `${l.meetings.length} meetings, ${l.meetings.reduce((s, x) => s + x.items, 0)} items`;
  });
  await check('dashboard', async () => {
    const d = await json<{ totals: { meetings: number; usdLedger: number } }>('/dashboard');
    return `${d.totals.meetings} meetings, spend recorded $${d.totals.usdLedger}`;
  });
  let sessionCode = '';
  await check('group recording: host creates, phone joins without login', async () => {
    const s = await json<{ code: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'demo-check' }),
    });
    sessionCode = s.code;
    const savedToken = token;
    token = ''; // the phone is not logged in
    try {
      const j = await json<{ participantId: string; token: string; state: string }>(
        `/join/${s.code}`,
        { method: 'POST', body: JSON.stringify({ name: 'Check phone' }) },
      );
      const hb = await json<{ state: string }>(`/join/${s.code}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ pid: j.participantId, token: j.token, level: -30, status: 'ready' }),
      });
      need(hb.state === 'lobby', `state ${hb.state}`);
      const bad = await call(`/join/${s.code}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ pid: j.participantId, token: 'wrong' }),
      });
      need(bad.status === 401, 'a wrong token was accepted');
    } finally {
      token = savedToken;
    }
    const view = await json<{ participants: { name: string; status: string }[] }>(
      `/sessions/${s.code}`,
    );
    need(
      view.participants.some((p) => p.name === 'Check phone'),
      'host does not see the phone',
    );
    return `code ${s.code}`;
  });

  // remove the throw-away session
  const cfg = env();
  await connectMongo(cfg.MONGODB_URI, cfg.MONGODB_DB);
  if (sessionCode) {
    const s = await SessionModel.findOne({ code: sessionCode });
    if (s) {
      await ParticipantModel.deleteMany({ sessionId: s._id });
      await SessionModel.deleteOne({ _id: s._id });
    }
  }
  await disconnectMongo();

  for (const r of results)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  — ${r.note}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
