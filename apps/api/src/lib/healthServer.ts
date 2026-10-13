import { createServer, type Server } from 'node:http';

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
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, role: 'worker', ...status() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}
