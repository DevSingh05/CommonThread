/**
 * Provisional client-side view of the shared protocol.
 *
 * `src/contracts.ts` (owned by the conversation-engine branch) becomes the
 * authoritative contract once it lands. Until then this module mirrors
 * `docs/contracts.md` and is the only place the UI defines wire shapes, so the
 * integration merge replaces these declarations with re-exports instead of
 * touching every component.
 *
 * Everything the server sends is untrusted at this boundary: responses are
 * parsed with Zod, unknown properties are dropped, and fields the engine has
 * not finalised are optional so the UI degrades instead of crashing.
 */
import { z } from 'zod';

export const participantIds = ['human', 'claude', 'codex', 'system'] as const;
export const agentIds = ['claude', 'codex'] as const;

export const ParticipantId = z.enum(participantIds);
export type ParticipantId = z.infer<typeof ParticipantId>;
export const AgentId = z.enum(agentIds);
export type AgentId = z.infer<typeof AgentId>;

export const RoomMode = z.enum(['demo', 'live']);
export type RoomMode = z.infer<typeof RoomMode>;

export const RunStatus = z.enum([
  'running',
  'waiting_for_user',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const TaskStatus = z.enum([
  'open',
  'in_progress',
  'waiting_for_agent',
  'waiting_for_user',
  'completed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TurnStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export type TurnStatus = z.infer<typeof TurnStatus>;

const Id = z.string().min(1);
const Timestamp = z.string().min(1);

export const ArtifactRef = z.object({ artifactId: Id, version: z.number().int().positive() });
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const Usage = z.object({
  kind: z.enum(['reported', 'estimated', 'unavailable']),
  inputTokens: z.number().nonnegative().nullish(),
  outputTokens: z.number().nonnegative().nullish(),
});
export type Usage = z.infer<typeof Usage>;

export const Room = z.object({
  id: Id,
  title: z.string(),
  goal: z.string(),
  repositoryPath: z.string().nullish(),
  mode: RoomMode,
  createdAt: Timestamp,
});
export type Room = z.infer<typeof Room>;

export const Run = z.object({
  id: Id,
  roomId: Id,
  generation: z.number().int().nonnegative(),
  status: RunStatus,
  maxTurns: z.number().int().positive(),
  turnCount: z.number().int().nonnegative(),
  reason: z.string().nullish(),
  createdAt: Timestamp.optional(),
  updatedAt: Timestamp.optional(),
});
export type Run = z.infer<typeof Run>;

export const Task = z.object({
  id: Id,
  roomId: Id,
  runId: Id.nullish(),
  title: z.string(),
  status: TaskStatus,
  owner: ParticipantId.nullish(),
  correctionCount: z.number().int().nonnegative().default(0),
  summary: z.string().nullish(),
  unresolvedIssues: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof Task>;

export const Turn = z.object({
  id: Id,
  roomId: Id,
  runId: Id.nullish(),
  taskId: Id.nullish(),
  agent: AgentId,
  generation: z.number().int().nonnegative(),
  status: TurnStatus,
  request: z.string().nullish(),
  attempts: z.number().int().nonnegative().default(0),
  createdAt: Timestamp.optional(),
  startedAt: Timestamp.nullish(),
  endedAt: Timestamp.nullish(),
  usage: Usage.nullish(),
  /**
   * Proposed additive field: highest message `seq` included in this turn's
   * context. When absent the UI falls back to the agent session cursor.
   */
  contextSeq: z.number().int().nonnegative().nullish(),
});
export type Turn = z.infer<typeof Turn>;

/**
 * Message kinds the UI renders specially. The engine may add kinds; anything
 * unrecognised falls back to a plain attributed message.
 */
export const knownMessageKinds = [
  'chat',
  'handoff',
  'question',
  'proposal',
  'decision',
  'artifact',
  'review',
  'task_completed',
  'activity',
  'system',
] as const;
export type KnownMessageKind = (typeof knownMessageKinds)[number];

export const Message = z.object({
  id: Id,
  seq: z.number().int().nonnegative(),
  roomId: Id,
  author: ParticipantId,
  kind: z.string().min(1),
  body: z.string(),
  createdAt: Timestamp,
  recipient: ParticipantId.nullish(),
  replyTo: Id.nullish(),
  taskId: Id.nullish(),
  runId: Id.nullish(),
  artifactRefs: z.array(ArtifactRef).default([]),
  data: z.record(z.string(), z.unknown()).nullish(),
});
export type Message = z.infer<typeof Message>;

export const ArtifactVersion = z.object({
  artifactId: Id,
  version: z.number().int().positive(),
  roomId: Id,
  title: z.string(),
  /** Snapshots may omit content; fetch the exact version to inspect it. */
  content: z.string().optional(),
  createdAt: Timestamp,
  author: ParticipantId,
  taskId: Id.nullish(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

export const FindingSeverity = z.enum(['critical', 'major', 'minor', 'info']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const Finding = z.object({
  id: Id,
  severity: FindingSeverity,
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  explanation: z.string(),
  evidence: z.string().nullish(),
  suggestedNextAction: z.string().nullish(),
  resolved: z.boolean().default(false),
});
export type Finding = z.infer<typeof Finding>;

export const Review = z.object({
  id: Id,
  roomId: Id,
  author: ParticipantId,
  artifactRef: ArtifactRef,
  summary: z.string(),
  findings: z.array(Finding).default([]),
  createdAt: Timestamp,
});
export type Review = z.infer<typeof Review>;

export const Session = z.object({
  id: Id,
  roomId: Id,
  agent: AgentId,
  /** e.g. `new`, `active`, `resume_failed`, `fresh`. Rendered verbatim. */
  state: z.string(),
  /** Highest message `seq` committed as delivered to this agent. */
  deliveredSeq: z.number().int().nonnegative().nullish(),
  createdAt: Timestamp.optional(),
  updatedAt: Timestamp.optional(),
});
export type Session = z.infer<typeof Session>;

export const RoomSnapshot = z.object({
  room: Room,
  run: Run.nullish(),
  tasks: z.array(Task).default([]),
  turns: z.array(Turn).default([]),
  messages: z.array(Message).default([]),
  artifacts: z.array(ArtifactVersion).default([]),
  reviews: z.array(Review).default([]),
  sessions: z.array(Session).default([]),
  /** Last persisted event sequence; lets the client detect missed SSE notifications. */
  eventSeq: z.number().int().nonnegative().default(0),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshot>;

export const RoomSummary = Room.extend({ runStatus: RunStatus.nullish() });
export type RoomSummary = z.infer<typeof RoomSummary>;

export const RoomList = z.object({ rooms: z.array(RoomSummary) });

export const Capability = z.object({ available: z.boolean(), reason: z.string().nullish() });
export type Capability = z.infer<typeof Capability>;

const unreported: Capability = { available: false, reason: 'The engine did not report this capability.' };

export const Capabilities = z.object({
  demo: Capability.default({ available: true }),
  live: Capability.default(unreported),
  repository: Capability.default(unreported),
  recovery: Capability.default({ available: true }),
  freshSession: Capability.default({ available: true }),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const Bootstrap = z.object({
  token: z.string().min(1),
  capabilities: Capabilities.default(Capabilities.parse({})),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const ApiErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** Stream event payload — provisional output that is never committed chat. */
export const StreamEvent = z.object({
  turnId: Id,
  agent: AgentId,
  kind: z.enum(['text', 'tool']).default('text'),
  text: z.string(),
});
export type StreamEvent = z.infer<typeof StreamEvent>;

export const SnapshotEvent = z.object({ roomId: Id, eventSeq: z.number().int().nonnegative().optional() });

// ---- Request bodies -------------------------------------------------------

export interface CreateRoomInput {
  title: string;
  goal: string;
  mode: RoomMode;
  repositoryPath?: string;
}

export interface MessageInput {
  body: string;
  recipient?: AgentId;
  replyTo?: string;
}

export interface GoalInput {
  goal: string;
}

export type ControlInput =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'stop' }
  | { action: 'recover'; acknowledgeUncertain: true }
  | { action: 'fresh_session'; agent: AgentId };
