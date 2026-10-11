import type {
  AgentId,
  ArtifactRef,
  ArtifactVersion,
  Finding,
  Message,
  Review,
  RoomSnapshot,
  Turn,
} from '../contract';

/** Derived, read-only views over a server snapshot. The snapshot stays the only state. */

export function activeTurn(snapshot: RoomSnapshot): Turn | null {
  if (snapshot.activeTurnId !== undefined) return snapshot.turns.find(turn => turn.id === snapshot.activeTurnId) ?? null;
  return snapshot.turns.find((turn) => turn.status === 'running') ?? null;
}

export function queuedTurns(snapshot: RoomSnapshot): Turn[] {
  return snapshot.turns.filter((turn) => turn.status === 'queued' && (!snapshot.run || turn.runId === snapshot.run.id));
}

export function sessionFor(snapshot: RoomSnapshot, agent: AgentId) {
  return snapshot.sessions.find((session) => session.agent === agent) ?? null;
}

/**
 * Human messages saved while a turn runs but not part of that turn's context.
 * They reach an agent on its next turn; the UI must not imply mid-turn steering.
 */
export function pendingGuidanceIds(snapshot: RoomSnapshot): Set<string> {
  if (snapshot.pendingHumanMessageIds !== undefined) return new Set(snapshot.pendingHumanMessageIds);
  const turn = activeTurn(snapshot);
  if (turn === null) return new Set();
  const session = sessionFor(snapshot, turn.agent);
  const cutoff = turn.contextSeq ?? session?.deliveredCursor ?? session?.deliveredSeq ?? null;
  if (cutoff === null) return new Set();
  return new Set(
    snapshot.messages
      .filter((message) => message.author === 'human' && message.seq > cutoff)
      .map((message) => message.id),
  );
}

export function latestHumanGuidance(snapshot: RoomSnapshot): Message | null {
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const message = snapshot.messages[i];
    if (message?.author === 'human') return message;
  }
  return null;
}

export function isQuestionAnswered(question: Message, messages: readonly Message[]): boolean {
  if (question.data?.answered === true) return true;
  return messages.some((message) => message.author === 'human' && message.replyTo === question.id);
}

export function openQuestions(snapshot: RoomSnapshot): Message[] {
  return snapshot.messages.filter(
    (message) => message.kind === 'question' && !isQuestionAnswered(message, snapshot.messages),
  );
}

export interface ArtifactHistory {
  artifactId: string;
  title: string;
  versions: ArtifactVersion[];
  latest: ArtifactVersion;
}

export function artifactHistories(artifacts: readonly ArtifactVersion[]): ArtifactHistory[] {
  const byId = new Map<string, ArtifactVersion[]>();
  for (const artifact of artifacts) {
    const versions = byId.get(artifact.artifactId) ?? [];
    versions.push(artifact);
    byId.set(artifact.artifactId, versions);
  }
  const histories: ArtifactHistory[] = [];
  for (const [artifactId, versions] of byId) {
    versions.sort((a, b) => a.version - b.version);
    const latest = versions[versions.length - 1];
    if (latest !== undefined) histories.push({ artifactId, title: latest.title, versions, latest });
  }
  return histories;
}

export function latestVersion(artifacts: readonly ArtifactVersion[], artifactId: string): number | null {
  let latest: number | null = null;
  for (const artifact of artifacts) {
    if (artifact.artifactId === artifactId && (latest === null || artifact.version > latest)) {
      latest = artifact.version;
    }
  }
  return latest;
}

export function isStaleRef(artifacts: readonly ArtifactVersion[], ref: ArtifactRef): boolean {
  const latest = latestVersion(artifacts, ref.artifactId);
  return latest !== null && latest > ref.version;
}

export function reviewsFor(reviews: readonly Review[], ref: ArtifactRef): Review[] {
  return reviews.filter(
    (review) => review.artifactRef.artifactId === ref.artifactId && review.artifactRef.version === ref.version,
  );
}

export interface OpenFinding {
  finding: Finding;
  review: Review;
}

/** Unresolved findings from the most recent review of each artifact. */
export function openFindings(snapshot: RoomSnapshot): OpenFinding[] {
  const newest = new Map<string, Review>();
  for (const review of snapshot.reviews) {
    const current = newest.get(review.artifactRef.artifactId);
    if (current === undefined || review.artifactRef.version >= current.artifactRef.version) {
      newest.set(review.artifactRef.artifactId, review);
    }
  }
  return [...newest.values()].flatMap((review) =>
    review.findings.filter((finding) => !finding.resolved).map((finding) => ({ finding, review })),
  );
}

export interface UsageSummary {
  reportedInput: number;
  reportedOutput: number;
  reportedTurns: number;
  estimatedInput: number;
  estimatedOutput: number;
  estimatedTurns: number;
  unavailableTurns: number;
}

/** Totals only what the provider reported or estimated; never fills gaps. */
export function summarizeUsage(turns: readonly Turn[]): UsageSummary {
  const summary: UsageSummary = {
    reportedInput: 0,
    reportedOutput: 0,
    reportedTurns: 0,
    estimatedInput: 0,
    estimatedOutput: 0,
    estimatedTurns: 0,
    unavailableTurns: 0,
  };
  for (const turn of turns) {
    if (turn.status === 'queued') continue;
    const usage = turn.usage;
    if (usage === null || usage === undefined || usage.kind === 'unavailable') {
      if (turn.status !== 'running') summary.unavailableTurns++;
    } else if (usage.kind === 'reported') {
      summary.reportedTurns++;
      summary.reportedInput += usage.inputTokens ?? 0;
      summary.reportedOutput += usage.outputTokens ?? 0;
    } else {
      summary.estimatedTurns++;
      summary.estimatedInput += usage.inputTokens ?? 0;
      summary.estimatedOutput += usage.outputTokens ?? 0;
    }
  }
  return summary;
}

/** Group consecutive activity/system messages so diagnostics stay collapsed. */
export type ThreadItem =
  | { type: 'message'; message: Message }
  | { type: 'activity'; messages: Message[] };

export function threadItems(messages: readonly Message[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.kind === 'activity') {
      const last = items[items.length - 1];
      if (last?.type === 'activity') last.messages.push(message);
      else items.push({ type: 'activity', messages: [message] });
    } else {
      items.push({ type: 'message', message });
    }
  }
  return items;
}
