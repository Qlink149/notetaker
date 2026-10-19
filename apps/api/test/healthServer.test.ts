import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHealthServer, startHealthThread } from '../src/lib/healthServer.js';

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
  it('answers HEAD /health with 200 and no body (the free UptimeRobot plan checks with HEAD)', async () => {
    const res = await fetch(`${url}/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
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

describe('worker health endpoint on its own thread', () => {
  it('still answers within Render’s 5 s while the main thread is busy for longer', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const health = startHealthThread(port, { concurrency: 1 });
    const url = `http://127.0.0.1:${port}/health`;
    for (let i = 0; i < 50; i++) {
      if (
        await fetch(url).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // another process checks the endpoint while this thread is blocked, like Render's health check
    const check = spawn(process.execPath, [
      '-e',
      `setTimeout(async()=>{const t=Date.now();const r=await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(2000)});console.log(r.status, Date.now()-t)},300)`,
    ]);
    let out = '';
    check.stdout.on('data', (d) => (out += String(d)));
    const until = Date.now() + 3000;
    while (Date.now() < until); // the main thread is busy for 3 s (a long assembly step)
    await new Promise((r) => check.on('exit', r));
    await health.close();
    const [status, ms] = out.trim().split(' ').map(Number);
    expect(status).toBe(200);
    expect(ms).toBeLessThan(2000);
  });
});
