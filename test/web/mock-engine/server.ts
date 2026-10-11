/**
 * HTTP surface of the test-only mock engine. Mirrors the provisional request
 * protections (localhost host, same origin, JSON, token, idempotency key) so
 * browser tests prove the UI sends them correctly.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpError, MockEngine, type EngineOptions } from './engine.ts';

export interface MockServer {
  server: Server;
  engine: MockEngine;
  url: string;
  close: () => Promise<void>;
}

const maxBody = 64 * 1024;

export async function startMockServer(port: number, options: Partial<EngineOptions> = {}): Promise<MockServer> {
  const engine = new MockEngine(options);
  const token = randomUUID();
  const idempotency = new Map<string, { fingerprint: string; status: number; body: unknown }>();
  const sse = new Set<ServerResponse>();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      } else {
        sendJson(res, 500, { error: { code: 'internal', message: error instanceof Error ? error.message : 'error' } });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';
    if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'host_not_allowed', 'Host header not allowed.');
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new HttpError(403, 'origin_not_allowed', 'Origin not allowed.');

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] === '__test') {
      const [, action, roomId] = parts;
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only.');
      if (action === 'drop-sse') {
        for (const client of sse) client.end();
        sse.clear();
      } else if (action === 'interrupt' && roomId !== undefined) {
        engine.interrupt(roomId);
      } else if (action === 'quiet-message' && roomId !== undefined) {
        const body = (await readBody(req)) as { body?: string };
        engine.appendQuietly(roomId, body.body ?? 'quiet');
      } else {
        throw new HttpError(404, 'not_found', 'Unknown test hook.');
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (parts[0] !== 'api') throw new HttpError(404, 'not_found', 'Not found.');
    const route = parts.slice(1);

    if (method === 'GET') {
      if (route[0] === 'health' && route.length === 1) {
        sendJson(res, 200, { ok: true, engine: 'mock' });
        return;
      }
      if (route[0] === 'bootstrap' && route.length === 1) {
        sendJson(res, 200, {
          token,
          capabilities: {
            demo: { available: true },
            live: { available: false, reason: 'live Claude/Codex adapters and repository guards are not registered (mock engine).' },
            repository: { available: false, reason: 'repository safeguards are not registered (mock engine).' },
            recovery: { available: true },
            freshSession: { available: true },
          },
        });
        return;
      }
      if (route[0] === 'rooms' && route.length === 1) {
        sendJson(res, 200, { rooms: engine.listRooms() });
        return;
      }
      if (route[0] === 'rooms' && route[1] !== undefined) {
        const roomId = route[1];
        if (route.length === 2) {
          sendJson(res, 200, engine.snapshot(roomId));
          return;
        }
        if (route[2] === 'events' && route.length === 3) {
          openEvents(req, res, roomId);
          return;
        }
        if (route[2] === 'artifacts' && route.length === 5) {
          sendJson(res, 200, engine.artifact(roomId, route[3] ?? '', Number(route[4])));
          return;
        }
        if (route[2] === 'messages' && route.length === 4) {
          sendJson(res, 200, engine.message(roomId, route[3] ?? ''));
          return;
        }
        if (route[2] === 'tasks' && route.length === 4) {
          sendJson(res, 200, engine.task(roomId, route[3] ?? ''));
          return;
        }
      }
      throw new HttpError(404, 'not_found', 'Not found.');
    }

    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'json_required', 'Mutations require Content-Type: application/json.');
    }
    if (req.headers['x-commonthread-token'] !== token) throw new HttpError(403, 'invalid_token', 'Missing or invalid X-CommonThread-Token.');
    const key = header(req, 'idempotency-key');
    if (key === undefined || key === '') throw new HttpError(400, 'idempotency_key_required', 'Idempotency-Key header required.');

    const body = await readBody(req);
    const fingerprint = createHash('sha256').update(`${url.pathname}\n${JSON.stringify(body)}`).digest('hex');
    const previous = idempotency.get(key);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        throw new HttpError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
      }
      res.setHeader('Idempotent-Replay', 'true');
      sendJson(res, previous.status, previous.body);
      return;
    }

    const result = mutate(route, body);
    idempotency.set(key, { fingerprint, status: 200, body: result });
    sendJson(res, 200, result);
  }

  function mutate(route: string[], body: unknown): unknown {
    const input = asRecord(body);
    if (route[0] === 'rooms' && route.length === 1) {
      const title = requireString(input, 'title');
      const goal = requireString(input, 'goal');
      const mode = requireString(input, 'mode');
      const repositoryPath = typeof input.repositoryPath === 'string' ? input.repositoryPath : undefined;
      return { room: engine.createRoom({ title, goal, mode, ...(repositoryPath === undefined ? {} : { repositoryPath }) }) };
    }
    const roomId = route[1];
    if (route[0] === 'rooms' && roomId !== undefined && route.length === 3) {
      if (route[2] === 'messages') {
        const recipient = input.recipient;
        if (recipient !== undefined && recipient !== 'claude' && recipient !== 'codex') {
          throw new HttpError(400, 'invalid_recipient', 'recipient must be claude or codex.');
        }
        const replyTo = typeof input.replyTo === 'string' ? input.replyTo : undefined;
        return {
          message: engine.postMessage(roomId, {
            body: requireString(input, 'body'),
            ...(recipient === undefined ? {} : { recipient }),
            ...(replyTo === undefined ? {} : { replyTo }),
          }),
        };
      }
      if (route[2] === 'goal') {
        engine.updateGoal(roomId, requireString(input, 'goal'));
        return { ok: true };
      }
      if (route[2] === 'control') {
        const action = requireString(input, 'action');
        const agent = input.agent === 'claude' || input.agent === 'codex' ? input.agent : undefined;
        engine.control(roomId, {
          action,
          ...(input.acknowledgeUncertain === true ? { acknowledgeUncertain: true } : {}),
          ...(agent === undefined ? {} : { agent }),
        });
        return { ok: true };
      }
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  function openEvents(req: IncomingMessage, res: ServerResponse, roomId: string) {
    engine.snapshot(roomId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 500\n\n');
    sse.add(res);
    const unsubscribe = engine.subscribe(roomId, (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      sse.delete(res);
    });
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    engine,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        engine.close();
        for (const client of sse) client.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBody) throw new HttpError(413, 'body_too_large', 'Request body too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not valid JSON.');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_body', 'Body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'invalid_body', `${key} is required.`);
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
