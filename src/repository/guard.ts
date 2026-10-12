import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ArtifactRef, RepositoryGuard, Room, Turn } from '../contracts.js';
import { AppError, invariant } from '../core/errors.js';
import type { Store } from '../core/store.js';
import { RepositoryArtifacts } from './artifacts.js';
import { executeBounded, type Command } from './process.js';
import { canonicalizeRepository, captureStableSnapshot, changesBetween, type CaptureLimits, type RepositorySnapshot } from './snapshot.js';

type Access = 'read-only' | 'workspace-write';
interface TurnInput { room: Room; turn: Turn; signal: AbortSignal }
interface Lease {
  input: TurnInput; access: Access; before: RepositorySnapshot; checkpoint: RepositorySnapshot;
  baselineRef: ArtifactRef; commands: Set<Promise<ArtifactRef>>; closing: boolean; conflict: boolean;
}
export interface GuardOptions {
  limits?: CaptureLimits;
  /** Trusted policy, never inferred from turn prose. Defaults to read-only. */
  accessForTurn?: (input: { room: Room; turn: Turn }) => Access;
  /** Fixed host-owned command definitions. No agent-supplied args or executable. */
  commands?: Record<string, Omit<Command, 'cwd'>>;
  /** Required for every actual command invocation; absent means deny. */
  authorizeCommand?: (input: { room: Room; turn: Turn; commandId: string }) => boolean;
}
interface JournalEntry {
  kind: 'repository_baseline' | 'repository_capture' | 'repository_acknowledgement';
  snapshot: RepositorySnapshot; turnId: string;
}

export class LocalRepositoryGuard implements RepositoryGuard {
  readonly artifacts: RepositoryArtifacts;
  private readonly active = new Map<string, Lease>();
  private readonly preparing = new Set<string>();
  private readonly roots = new Set<string>();
  private readonly options: GuardOptions;
  constructor(private readonly store: Store, options: GuardOptions = {}) {
    this.artifacts = new RepositoryArtifacts(store);
    this.options = { ...options, limits: options.limits ? { ...options.limits } : undefined,
      commands: Object.fromEntries(Object.entries(options.commands ?? {}).map(([id, command]) => [id, { ...command, args: [...command.args] }])) };
  }

  private latest(root: string): JournalEntry | undefined {
    let latest: JournalEntry | undefined;
    for (const artifact of this.store.list('artifacts')) {
      if (artifact.author !== 'system' || artifact.title !== 'Repository evidence: journal') continue;
      // These records are exclusively produced by this trusted host module, not provider prose.
      const entry = JSON.parse(artifact.content) as JournalEntry;
      if (entry.snapshot.identity.root === root) latest = entry;
    }
    return latest;
  }

  async beforeTurn(input: TurnInput): Promise<unknown> {
    input.signal.throwIfAborted();
    invariant(input.room.mode === 'live' && input.room.repositoryPath, 'INVALID_REPOSITORY', 'Repository guards require a live repository room.');
    const stored = this.store.require('turns', input.turn.id);
    invariant(stored.status === 'running' && stored.roomId === input.room.id, 'REPOSITORY_OWNERSHIP', 'Only an engine-owned running turn may acquire repository access.');
    const identity = await canonicalizeRepository(input.room.repositoryPath, input.signal);
    invariant(await realpath(input.room.repositoryPath) === identity.root, 'CANONICAL_ROOT_REQUIRED', 'Create the room with canonicalizeRepository(path).root; subdirectories are not execution identities.');
    invariant(!this.roots.has(identity.root), 'REPOSITORY_BUSY', 'Repository access is already active; use the engine ownership path.');
    this.roots.add(identity.root); this.preparing.add(input.turn.id);
    try {
      const access = z.enum(['read-only', 'workspace-write']).parse(this.options.accessForTurn?.(input) ?? 'read-only');
      const snapshot = await captureStableSnapshot(identity, input.signal, this.options.limits);
      const latest = this.latest(identity.root);
      const baselineRef = this.artifacts.append(input.room.id, input.turn.taskId, 'journal', {
        kind: 'repository_baseline', snapshot, turnId: input.turn.id, access, provenance: 'observed',
        previousState: latest ? latest.snapshot.digest === snapshot.digest ? 'unchanged' : 'external_change' : 'initial',
      });
      invariant(!latest || (latest.kind !== 'repository_baseline' && latest.snapshot.digest === snapshot.digest),
        'EXTERNAL_CHANGE', 'External changes or an unfinished capture require human acknowledgement of the captured baseline digest. No reconciliation was attempted.');
      const lease: Lease = { input, access, before: snapshot, checkpoint: snapshot, baselineRef, commands: new Set(), closing: false, conflict: false };
      this.active.set(input.turn.id, lease);
      return lease;
    } catch (error) { this.roots.delete(identity.root); throw error; }
    finally { this.preparing.delete(input.turn.id); }
  }

  private lease(roomId: string, turnId: string): Lease {
    const lease = this.active.get(turnId);
    invariant(lease && lease.input.room.id === roomId && !lease.closing, 'REPOSITORY_OWNERSHIP', 'An active guard lease for this room and turn is required.');
    lease.input.signal.throwIfAborted();
    return lease;
  }

  /** Provider adapters translate this trusted policy into their SDK's supported permissions. */
  getTurnContext(roomId: string, turnId: string): { cwd: string; access: Access; baselineRef: ArtifactRef } {
    const lease = this.lease(roomId, turnId);
    return { cwd: lease.before.identity.root, access: lease.access, baselineRef: { ...lease.baselineRef } };
  }

  async assertUnchanged(roomId: string, turnId: string): Promise<void> {
    const lease = this.lease(roomId, turnId);
    const current = await captureStableSnapshot(lease.before.identity, lease.input.signal, this.options.limits);
    if (current.digest !== lease.checkpoint.digest) { lease.conflict = true; throw new AppError('EXTERNAL_CHANGE', 'Repository changed since its last checkpoint. Destructive reconciliation is refused.'); }
  }

  runCommand(roomId: string, turnId: string, commandId: string): Promise<ArtifactRef> {
    const lease = this.lease(roomId, turnId);
    z.string().min(1).max(100).parse(commandId);
    const command = Object.hasOwn(this.options.commands ?? {}, commandId) ? this.options.commands?.[commandId] : undefined;
    invariant(command && isAbsolute(command.executable) && this.options.authorizeCommand?.({ ...lease.input, commandId }) === true,
      'COMMAND_DENIED', 'Command requires a fixed absolute executable and explicit trusted host authorization.');
    invariant(lease.access === 'workspace-write', 'COMMAND_DENIED', 'Read-only review turns cannot run arbitrary project commands.');
    invariant(lease.commands.size === 0, 'COMMAND_BUSY', 'Only one evidence command may run within a turn.');
    const pending = this.executeCommand(lease, command);
    lease.commands.add(pending);
    void pending.finally(() => lease.commands.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async executeCommand(lease: Lease, command: Omit<Command, 'cwd'>): Promise<ArtifactRef> {
    await this.assertUnchanged(lease.input.room.id, lease.input.turn.id);
    // Recheck revocation after asynchronous capture, immediately before process creation.
    lease.input.signal.throwIfAborted();
    const result = await executeBounded({ ...command, cwd: lease.before.identity.root }, lease.input.signal);
    const { stdout, stderr, ...metadata } = result;
    const outputRef = this.artifacts.append(lease.input.room.id, lease.input.turn.taskId, 'output', {
      kind: 'command_output', provenance: 'observed', turnId: lease.input.turn.id, stdout, stderr,
    });
    const ref = this.artifacts.append(lease.input.room.id, lease.input.turn.taskId, 'command', {
      kind: 'command_evidence', provenance: 'observed', turnId: lease.input.turn.id, ...metadata, outputRef,
      interpretation: 'Observed direct process result; exit zero alone does not prove tests passed. Descendant termination is not guaranteed.',
    });
    // On cancellation the engine still owns the repository; finalize with a separate bounded capture.
    lease.checkpoint = await captureStableSnapshot(lease.before.identity, AbortSignal.timeout(30_000), this.options.limits);
    return ref;
  }

  recordAssertion(roomId: string, turnId: string, input: unknown): ArtifactRef {
    const lease = this.lease(roomId, turnId);
    const assertion = z.strictObject({ provenance: z.enum(['agent_claim', 'fixture']), statement: z.string().min(1).max(16_000) }).parse(input);
    return this.artifacts.append(roomId, lease.input.turn.taskId, 'assertion', {
      kind: 'unverified_assertion', ...assertion, turnId, timestamp: new Date().toISOString(),
      status: assertion.provenance === 'fixture' ? 'simulated_not_run' : 'unverified',
      label: assertion.provenance === 'fixture' ? 'Simulated fixture; no command was run.' : 'Agent claim; not an observed command result.',
      command: null, cwd: lease.before.identity.root, exitCode: null, outputRef: null,
    });
  }

  async afterTurn(input: TurnInput & { baseline: unknown; outcome: 'completed' | 'failed' | 'cancelled' }): Promise<void> {
    const lease = this.active.get(input.turn.id);
    invariant(lease && lease === input.baseline && lease.input.room.id === input.room.id && !lease.closing,
      'REPOSITORY_OWNERSHIP', 'Guard finalization requires the original engine-owned baseline.');
    lease.closing = true;
    try {
      await Promise.allSettled([...lease.commands]);
      const snapshot = await captureStableSnapshot(lease.before.identity, AbortSignal.timeout(30_000), this.options.limits);
      const changed = snapshot.digest !== lease.before.digest;
      const violation = lease.conflict || (lease.access === 'read-only' && changed)
        || snapshot.head !== lease.before.head || snapshot.index !== lease.before.index;
      this.artifacts.append(input.room.id, input.turn.taskId, 'journal', {
        kind: violation ? 'repository_baseline' : 'repository_capture', snapshot, turnId: input.turn.id,
        baselineRef: lease.baselineRef, outcome: input.outcome, provenance: 'observed',
        access: lease.access, requiresAcknowledgement: violation, changes: changesBetween(lease.before, snapshot),
        attribution: 'Observed during turn; external editors cannot be distinguished from provider writes.',
      });
      invariant(!violation, 'EXTERNAL_CHANGE', 'Read-only, checkpoint, HEAD or index violation captured. Human inspection is required; no files were reverted.');
    } finally { this.active.delete(input.turn.id); this.roots.delete(lease.before.identity.root); }
  }

  /** Trusted human-control integration only. No provider/tool endpoint may expose this method. */
  async acknowledgeExternalChanges(roomId: string, taskId: string, expectedDigest: string): Promise<ArtifactRef> {
    z.string().regex(/^[a-f0-9]{64}$/u).parse(expectedDigest);
    const room = this.store.require('rooms', roomId);
    invariant(room.repositoryPath, 'INVALID_REPOSITORY', 'Room has no repository.');
    const identity = await canonicalizeRepository(room.repositoryPath);
    invariant(!this.roots.has(identity.root) && this.active.size === 0 && this.preparing.size === 0,
      'REPOSITORY_BUSY', 'Wait for repository execution to settle before acknowledging changes.');
    this.roots.add(identity.root);
    try {
      const snapshot = await captureStableSnapshot(identity, AbortSignal.timeout(30_000), this.options.limits);
      invariant(snapshot.digest === expectedDigest, 'EXTERNAL_CHANGE', 'Repository changed again; inspect the new state before acknowledging.');
      return this.artifacts.append(roomId, taskId, 'journal', { kind: 'repository_acknowledgement', snapshot, turnId: 'human', provenance: 'observed' });
    } finally { this.roots.delete(identity.root); }
  }
}

export function createRepositoryGuard(store: Store, options: GuardOptions = {}): LocalRepositoryGuard {
  return new LocalRepositoryGuard(store, options);
}
