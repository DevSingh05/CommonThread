import { DatabaseSync } from 'node:sqlite';
import type { ArtifactVersion, Message, Review, Room, Run, Session, Task, Turn } from '../contracts.js';
import { AppError } from './errors.js';

interface Receipt { id: string; roomId: string; fingerprint: string; result: unknown }
interface Tables { rooms: Room; runs: Run; tasks: Task; turns: Turn; sessions: Session; artifacts: ArtifactVersion; reviews: Review; receipts: Receipt }
type Table = keyof Tables;
const tables: Table[] = ['rooms', 'runs', 'tasks', 'turns', 'sessions', 'artifacts', 'reviews', 'receipts'];
type Row = { data: string };

/** Short synchronous transactions only. Provider work always happens outside them. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) { this.db.close(); throw new AppError('SCHEMA_VERSION', 'Database was created by a newer CommonThread version.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, seq);
    `);
    for (const table of tables) this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ${table}_room ON ${table}(room_id, seq);
    `);
    this.db.exec('PRAGMA user_version=1');
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<K extends Table>(table: K, id: string): Tables[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return row ? JSON.parse(row.data) as Tables[K] : undefined;
  }
  require<K extends Table>(table: K, id: string): Tables[K] {
    const item = this.get(table, id);
    if (!item) throw new AppError('NOT_FOUND', `${table} record not found.`, 404);
    return item;
  }
  list<K extends Table>(table: K, roomId?: string): Tables[K][] {
    const rows = (roomId === undefined
      ? this.db.prepare(`SELECT data FROM ${table} ORDER BY seq`).all()
      : this.db.prepare(`SELECT data FROM ${table} WHERE room_id = ? ORDER BY seq`).all(roomId)) as Row[];
    return rows.map(row => JSON.parse(row.data) as Tables[K]);
  }
  put<K extends Table>(table: K, value: Tables[K]): void {
    const roomId = 'roomId' in value ? value.roomId : value.id;
    this.db.prepare(`INSERT INTO ${table}(id, room_id, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id, roomId, JSON.stringify(value));
  }
  append(value: Omit<Message, 'seq'>): Message {
    const result = this.db.prepare('INSERT INTO messages(id, room_id, data) VALUES (?, ?, ?)').run(value.id, value.roomId, JSON.stringify(value));
    return { ...value, seq: Number(result.lastInsertRowid) };
  }
  messages(roomId: string, after = 0, limit = 10_000): Message[] {
    const rows = this.db.prepare('SELECT seq, data FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(roomId, after, limit) as (Row & { seq: number })[];
    return rows.map(row => ({ ...JSON.parse(row.data) as Omit<Message, 'seq'>, seq: row.seq }));
  }
  message(id: string): Message | undefined {
    const row = this.db.prepare('SELECT seq, data FROM messages WHERE id = ?').get(id) as (Row & { seq: number }) | undefined;
    return row ? { ...JSON.parse(row.data) as Omit<Message, 'seq'>, seq: row.seq } : undefined;
  }
}
