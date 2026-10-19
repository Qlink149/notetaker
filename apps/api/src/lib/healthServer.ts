import { createServer, type Server } from 'node:http';
import { Worker } from 'node:worker_threads';

/**
 * A minimal HTTP endpoint for a worker that runs as a Render *web* service (the free plan has no
 * background workers, and a web service must listen on a port and stays awake only while something
 * calls it). GET or HEAD /health answers 200 with a small JSON status; everything else is 404.
 */
export function startHealthServer(port: number, status: () => Record<string, unknown>): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    // HEAD too: the free UptimeRobot plan checks with HEAD requests, and a 404 there reads as "down".
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/health' || path === '/')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : JSON.stringify({ ok: true, role: 'worker', ...status() }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}

/**
 * The same endpoint on its own thread. Assembling a long meeting keeps the worker's single slow CPU busy for
 * longer than Render's 5-second health check allows; answered from the main thread, the check failed and Render
 * restarted the worker mid-job, five times in a row on 19 Oct ("Jolto Followup"). A separate thread answers
 * regardless. A worker that really hangs is still caught: its job's lease expires and the job is reclaimed.
 */
export function startHealthThread(
  port: number,
  status: Record<string, string | number>,
): { close: () => Promise<number> } {
  const code = `
    const { workerData } = require('node:worker_threads');
    const { createServer } = require('node:http');
    const startedAt = Date.now();
    createServer((req, res) => {
      const path = (req.url || '').split('?')[0];
      if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/health' || path === '/')) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
          ok: true, role: 'worker', uptimeSec: Math.round((Date.now() - startedAt) / 1000), ...workerData.status,
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }).listen(workerData.port, '0.0.0.0');
  `;
  const thread = new Worker(code, { eval: true, workerData: { port, status } });
  return { close: () => thread.terminate() };
}
