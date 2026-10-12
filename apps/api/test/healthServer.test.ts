import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHealthServer } from '../src/lib/healthServer.js';

// A worker running as a Render web service must answer HTTP so the platform (and an uptime monitor) can
// see it, and must not expose anything else.
let url: string;
let server: ReturnType<typeof startHealthServer>;
beforeAll(async () => {
  server = startHealthServer(0, () => ({ uptimeSec: 7, concurrency: 1 }));
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('worker health endpoint', () => {
  it('answers GET /health with a small JSON status', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true, role: 'worker', uptimeSec: 7, concurrency: 1 });
  });
  it('also answers / and ignores a query string (uptime monitors vary)', async () => {
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/health?x=1`)).status).toBe(200);
  });
  it('refuses everything else', async () => {
    expect((await fetch(`${url}/api/v1/meetings`)).status).toBe(404);
    expect((await fetch(`${url}/health`, { method: 'POST' })).status).toBe(404);
  });
});
