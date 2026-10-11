import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { Engine } from '../core/engine.js';
import { AppError } from '../core/errors.js';
import { artifactRefSchema, idSchema } from '../contracts.js';

export interface HttpOptions { port?: number; webDirectory?: string; devOrigins?: string[] }
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 256_000) throw new AppError('BODY_TOO_LARGE', 'Request body exceeds 256 KB.', 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new AppError('INVALID_JSON', 'Request body must be valid JSON.', 400); }
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/** Same-origin local API. No permissive CORS and no provider credentials in browser responses. */
export async function startHttpServer(engine: Engine, options: HttpOptions = {}) {
  const token = randomBytes(32).toString('hex');
  const clients = new Set<ServerResponse>();
  const devOrigins = options.devOrigins ?? [];
  for (const origin of devOrigins) {
    const url = new URL(origin);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:' || url.origin !== origin) throw new AppError('INVALID_ORIGIN_CONFIG', 'Development origins must be exact localhost HTTP origins.');
  }
  const server = createServer((request, response) => {
    void route(request, response).catch(error => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ZodError) { json(response, 400, { error: { code: 'INVALID_INPUT', message: 'Request failed validation.', issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) } }); }
      else if (error instanceof AppError) json(response, error.status, { error: { code: error.code, message: error.message } });
      else json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'The local server could not complete this request.' } });
    });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address = server.address();
    if (!address || typeof address === 'string') throw new AppError('NOT_READY', 'Server is not ready.', 503);
    const expectedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
    if (!request.headers.host || !expectedHosts.includes(request.headers.host)) throw new AppError('HOST_REJECTED', 'Only this localhost service host is allowed.', 403);
    const allowedOrigins = [...expectedHosts.map(host => `http://${host}`), ...devOrigins];
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) throw new AppError('ORIGIN_REJECTED', 'Cross-origin requests are not allowed.', 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('ORIGIN_REJECTED', 'Cross-site browser requests are not allowed.', 403);
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method;
    if (method === 'GET' && url.pathname === '/api/health') { json(response, 200, { ok: true, service: 'CommonThread', mode: 'local' }); return; }
    if (method === 'GET' && url.pathname === '/api/bootstrap') { json(response, 200, { token, capabilities: engine.capabilities(), version: '0.1.0' }); return; }
    if (method !== 'GET' && method !== 'HEAD') {
      const supplied = request.headers['x-commonthread-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new AppError('TOKEN_REQUIRED', 'Load /api/bootstrap and send its token as X-CommonThread-Token.', 403);
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new AppError('JSON_REQUIRED', 'Content-Type must be application/json.', 415);
    }
    const idempotencyKey = (): string => {
      const value = request.headers['idempotency-key'];
      if (typeof value !== 'string') throw new AppError('IDEMPOTENCY_KEY', 'Idempotency-Key is required for mutations.', 400);
      return value;
    };
    if (url.pathname === '/api/rooms') {
      if (method === 'GET') { json(response, 200, { rooms: engine.listRooms() }); return; }
      if (method === 'POST') { const key = idempotencyKey(); json(response, 201, engine.createRoom(await body(request), key)); return; }
    }
    if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
      const roomId = idSchema.parse(parts[2]);
      if (parts.length === 3 && method === 'GET') { json(response, 200, engine.snapshot(roomId)); return; }
      if (parts.length === 4 && method === 'POST') {
        const key = idempotencyKey(); const input = await body(request);
        switch (parts[3]) {
          case 'messages': json(response, 201, engine.postHuman(roomId, input, key)); return;
          case 'goal': json(response, 200, engine.updateGoal(roomId, input, key)); return;
          case 'control': json(response, 200, engine.control(roomId, input, key)); return;
        }
      }
      if (method === 'GET' && parts[3] === 'events' && parts.length === 4) {
        const snapshot = engine.snapshot(roomId);
        if (clients.size >= 64) throw new AppError('TOO_MANY_STREAMS', 'Too many event streams are open.', 429);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(`event: snapshot\ndata: ${JSON.stringify({ roomId, cursor: snapshot.messages.at(-1)?.seq ?? 0 })}\n\n`);
        clients.add(response);
        const unsubscribe = engine.subscribe(event => {
          if (event.roomId !== roomId) return;
          if (response.writableLength > 256_000) { response.end(); return; }
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000); heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); clients.delete(response); });
        return;
      }
      if (method === 'GET' && parts[3] === 'messages' && parts.length === 5) { json(response, 200, engine.getMessage(roomId, idSchema.parse(parts[4]))); return; }
      if (method === 'GET' && parts[3] === 'tasks' && parts.length === 5) { json(response, 200, engine.getTask(roomId, idSchema.parse(parts[4]))); return; }
      if (method === 'GET' && parts[3] === 'artifacts' && parts.length === 6) {
        const ref = artifactRefSchema.parse({ artifactId: parts[4], version: Number(parts[5]) });
        json(response, 200, engine.getArtifact(roomId, ref)); return;
      }
    }
    if (method === 'GET' && !url.pathname.startsWith('/api') && options.webDirectory && existsSync(options.webDirectory)) {
      const root = realpathSync(options.webDirectory);
      let filename = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (filename !== root && !filename.startsWith(root + sep)) throw new AppError('INVALID_PATH', 'Invalid asset path.', 400);
      if (!existsSync(filename) || statSync(filename).isDirectory()) filename = resolve(root, 'index.html');
      if (existsSync(filename)) {
        filename = realpathSync(filename);
        if (!filename.startsWith(root + sep)) throw new AppError('INVALID_PATH', 'Asset escapes the web directory.', 400);
        response.writeHead(200, { 'Content-Type': mime[extname(filename)] ?? 'application/octet-stream' }); response.end(readFileSync(filename)); return;
      }
    }
    if (method === 'GET' && url.pathname === '/') {
      json(response, 200, { service: 'CommonThread conversation engine', simulatedDemo: true, ui: 'React UI is owned by feature/shared-room-ui; this branch provides the working API.', startup: 'npm run demo', health: '/api/health' }); return;
    }
    throw new AppError('NOT_FOUND', 'Endpoint not found.', 404);
  }
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(options.port ?? 4317, '127.0.0.1', () => { server.off('error', reject); done(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server address unavailable');
  return {
    server, url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      for (const response of clients) response.end();
      await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
    },
  };
}
