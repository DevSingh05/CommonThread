import { z } from 'zod';

export const agentSchema = z.enum(['claude', 'codex']);
export type AgentId = z.infer<typeof agentSchema>;
export type Author = AgentId | 'human' | 'system';
export const idSchema = z.uuid();
const body = z.string().trim().min(1).max(16_000);
export const artifactRefSchema = z.strictObject({ artifactId: idSchema, version: z.int().positive() });
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
const refs = z.array(artifactRefSchema).max(20);
export const findingSchema = z.strictObject({
  id: idSchema,
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  file: z.string().min(1).max(500),
  line: z.int().positive().optional(),
  explanation: body,
  evidence: body,
  nextAction: body,
});
export type Finding = z.infer<typeof findingSchema>;
export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('post_message'), body, recipient: agentSchema.optional(), replyTo: idSchema.optional(), artifactRefs: refs.optional() }),
  z.strictObject({ type: z.literal('handoff'), recipient: agentSchema, taskId: idSchema, request: body, relevantMessageIds: z.array(idSchema).max(20).optional(), artifactRefs: refs.optional(), revision: z.boolean().optional() }),
  z.strictObject({ type: z.literal('request_user_input'), question: body, taskId: idSchema.optional(), options: z.array(z.string().min(1).max(200)).max(8).optional() }),
  z.strictObject({ type: z.literal('propose_decision'), statement: body, rationale: body, taskId: idSchema.optional() }),
  z.strictObject({ type: z.literal('publish_artifact'), artifactId: idSchema.optional(), baseVersion: z.int().positive().optional(), title: z.string().min(1).max(200), content: z.string().max(100_000) }),
  z.strictObject({ type: z.literal('complete_task'), taskId: idSchema, summary: body, evidenceRefs: refs.optional(), unresolvedIssues: z.array(z.string().min(1).max(2000)).max(30).optional() }),
  z.strictObject({ type: z.literal('submit_review'), artifactRef: artifactRefSchema, summary: body, findings: z.array(findingSchema).max(50) }),
]);
export const actionBatchSchema = z.array(actionSchema).min(1).max(24);
export type Action = z.infer<typeof actionSchema>;

export const createRoomSchema = z.strictObject({
  title: z.string().trim().min(1).max(120), goal: body,
  mode: z.enum(['demo', 'live']).default('demo'), repositoryPath: z.string().min(1).max(4096).optional(),
});
export const humanMessageSchema = z.strictObject({ body, recipient: agentSchema.optional(), replyTo: idSchema.optional() });
export const goalSchema = z.strictObject({ goal: body });
export const controlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('resume') }),
  z.strictObject({ action: z.literal('stop') }),
  z.strictObject({ action: z.literal('recover'), acknowledgeUncertain: z.literal(true) }),
  z.strictObject({ action: z.literal('fresh_session'), agent: agentSchema, acknowledgeUncertain: z.literal(true) }),
]);
export type ControlInput = z.infer<typeof controlSchema>;
export type RunStatus = 'running' | 'waiting_for_user' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TaskStatus = 'open' | 'in_progress' | 'waiting_for_agent' | 'waiting_for_user' | 'completed' | 'cancelled';
export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type MessageKind = 'message' | 'handoff' | 'question' | 'decision' | 'artifact' | 'review' | 'completion' | 'status' | 'error' | 'goal';
export interface Room { id: string; title: string; goal: string; mode: 'demo' | 'live'; repositoryPath?: string; createdAt: string }
export interface Run {
  id: string; roomId: string; generation: number; status: RunStatus; maxTurns: number;
  turnCount: number; reason?: string; createdAt: string; updatedAt: string;
}
export interface Task {
  id: string; roomId: string; runId: string; title: string; status: TaskStatus; owner: AgentId;
  correctionCount: number; summary?: string; unresolvedIssues: string[]; createdAt: string;
}
export interface Message {
  id: string; seq: number; roomId: string; author: Author; kind: MessageKind; body: string; createdAt: string;
  recipient?: AgentId; replyTo?: string; taskId?: string; runId?: string; artifactRefs?: ArtifactRef[];
  data?: Record<string, unknown>;
}
export interface Turn {
  id: string; roomId: string; runId: string; taskId: string; agent: AgentId; generation: number;
  status: TurnStatus; request: string; relevantMessageIds: string[]; artifactRefs: ArtifactRef[];
  attempts: number; createdAt: string; startedAt?: string; completedAt?: string; usage?: Usage;
  deliveredCursor?: number; errorCode?: string;
}
export interface Session {
  id: string; roomId: string; agent: AgentId; providerSessionId?: string; repositoryPath?: string;
  state: 'fresh' | 'ready' | 'running' | 'resume_failed' | 'interrupted';
  deliveredCursor: number; createdAt: string; updatedAt: string;
}
export interface ArtifactVersion extends ArtifactRef {
  id: string; roomId: string; title: string; content: string; author: Author; taskId: string; createdAt: string;
}
export interface Review {
  id: string; roomId: string; taskId: string; author: AgentId; artifactRef: ArtifactRef;
  summary: string; findings: Finding[]; createdAt: string;
}
export const usageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.enum(['reported', 'estimated']), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
]);
export type Usage = z.infer<typeof usageSchema>;

export interface AgentContext {
  goal: string; agent: AgentId; task: Task; request: string;
  humanGuidance: Message[]; messages: Message[]; referencedMessages: Message[];
  decisions: Message[]; questions: Message[]; artifactRefs: ArtifactRef[];
  deliveryCursor: number; hasMoreMessages: boolean; truncatedMessageIds: string[];
  instructions: string;
}
export type StreamEvent = { type: 'text' | 'activity'; text: string };
export interface Retrieval {
  message(id: string): Message;
  task(id: string): Task;
  artifact(ref: ArtifactRef): ArtifactVersion;
}
export interface AdapterInput {
  room: Room; turn: Turn; session: Session; context: AgentContext; signal: AbortSignal;
  emit(event: StreamEvent): void; retrieve: Retrieval;
}
export interface AdapterResult {
  actions: unknown; providerSessionId?: string; usage?: Usage;
}
export interface AgentAdapter { execute(input: AdapterInput): Promise<AdapterResult> }
export type Adapters = Record<AgentId, AgentAdapter>;
export interface RepositoryGuard {
  beforeTurn(input: { room: Room; turn: Turn; signal: AbortSignal }): Promise<unknown>;
  afterTurn(input: { room: Room; turn: Turn; baseline: unknown; signal: AbortSignal; outcome: 'completed' | 'failed' | 'cancelled' }): Promise<void>;
}
export interface Snapshot {
  room: Room; run: Run | null; messages: Message[]; tasks: Task[]; turns: Turn[];
  sessions: Omit<Session, 'providerSessionId'>[]; artifacts: ArtifactVersion[]; reviews: Review[];
  pendingHumanMessageIds: string[]; activeTurnId: string | null;
}
export type EngineEvent = { type: 'snapshot'; roomId: string } | { type: 'stream'; roomId: string; turnId: string; agent: AgentId; event: StreamEvent };
