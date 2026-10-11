import type { z } from 'zod';
import {
  ArtifactVersion,
  Bootstrap,
  Message,
  RoomList,
  RoomSnapshot,
  Task,
  type ControlInput,
  type CreateRoomInput,
  type GoalInput,
  type MessageInput,
} from '../contract';
import { ApiError } from './errors';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Same-origin JSON client for the local engine.
 *
 * Reads are plain GETs. Every mutation carries the bootstrap CSRF token and a
 * caller-supplied idempotency key; the caller owns the key so a retry of the
 * same logical submit reuses it (see `SubmissionKeys`).
 */
export class ApiClient {
  private bootstrapPromise: Promise<Bootstrap> | null = null;
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.fetchImpl = fetchImpl;
  }

  bootstrap(): Promise<Bootstrap> {
    this.bootstrapPromise ??= this.get('/api/bootstrap', Bootstrap).catch((error: unknown) => {
      this.bootstrapPromise = null;
      throw error;
    });
    return this.bootstrapPromise;
  }

  listRooms() {
    return this.get('/api/rooms', RoomList).then((list) => list.rooms);
  }

  snapshot(roomId: string) {
    return this.get(`/api/rooms/${encodeURIComponent(roomId)}`, RoomSnapshot);
  }

  artifact(roomId: string, artifactId: string, version: number) {
    return this.get(
      `/api/rooms/${encodeURIComponent(roomId)}/artifacts/${encodeURIComponent(artifactId)}/${String(version)}`,
      ArtifactVersion,
    );
  }

  message(roomId: string, messageId: string) {
    return this.get(`/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, Message);
  }

  task(roomId: string, taskId: string) {
    return this.get(`/api/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}`, Task);
  }

  /** Returns the new room's id; the response may be the room or a snapshot. */
  async createRoom(input: CreateRoomInput, idempotencyKey: string): Promise<string> {
    const body = await this.mutate('/api/rooms', input, idempotencyKey);
    const id = extractRoomId(body);
    if (id === null) throw ApiError.invalidResponse('/api/rooms', 'missing room id');
    return id;
  }

  async postMessage(roomId: string, input: MessageInput, idempotencyKey: string): Promise<void> {
    await this.mutate(`/api/rooms/${encodeURIComponent(roomId)}/messages`, input, idempotencyKey);
  }

  async updateGoal(roomId: string, input: GoalInput, idempotencyKey: string): Promise<void> {
    await this.mutate(`/api/rooms/${encodeURIComponent(roomId)}/goal`, input, idempotencyKey);
  }

  async control(roomId: string, input: ControlInput, idempotencyKey: string): Promise<void> {
    await this.mutate(`/api/rooms/${encodeURIComponent(roomId)}/control`, input, idempotencyKey);
  }

  eventsUrl(roomId: string): string {
    return `/api/rooms/${encodeURIComponent(roomId)}/events`;
  }

  private async get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const response = await this.send(path, { method: 'GET', headers: { Accept: 'application/json' } });
    const parsed = schema.safeParse(await readJson(response, path));
    if (!parsed.success) {
      throw ApiError.invalidResponse(path, parsed.error.issues[0]?.message ?? 'schema mismatch');
    }
    return parsed.data;
  }

  private async mutate(path: string, body: unknown, idempotencyKey: string): Promise<unknown> {
    const attempt = async () => {
      const { token } = await this.bootstrap();
      return this.send(path, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CommonThread-Token': token,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    };
    let response: Response;
    try {
      response = await attempt();
    } catch (error) {
      // A restarted engine issues a new token. Refresh it once and resend the
      // same request with the same idempotency key.
      if (!(error instanceof ApiError) || !error.tokenRejected) throw error;
      this.bootstrapPromise = null;
      response = await attempt();
    }
    if (response.status === 204) return null;
    return readJson(response, path);
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(path, { ...init, credentials: 'same-origin' });
    } catch (error) {
      throw ApiError.network(error);
    }
    if (!response.ok) throw await ApiError.fromResponse(response);
    return response;
  }
}

async function readJson(response: Response, path: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw ApiError.invalidResponse(path, 'body is not JSON');
  }
}

function extractRoomId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const room = record.room;
  if (room !== null && typeof room === 'object' && typeof (room as Record<string, unknown>).id === 'string') {
    return (room as Record<string, string>).id ?? null;
  }
  return null;
}

export const api = new ApiClient();
