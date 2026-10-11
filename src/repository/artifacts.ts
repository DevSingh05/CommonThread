import { randomUUID } from 'node:crypto';
import { artifactRefSchema, type ArtifactRef, type ArtifactVersion } from '../contracts.js';
import { invariant } from '../core/errors.js';
import type { Store } from '../core/store.js';

/** Trusted host-only publisher. Uses the engine's SQLite store, never a parallel data store. */
export class RepositoryArtifacts {
  constructor(private readonly store: Store) {}

  append(roomId: string, taskId: string, stream: 'journal' | 'command' | 'output' | 'assertion', value: unknown): ArtifactRef {
    const content = JSON.stringify(value);
    invariant(content !== undefined && Buffer.byteLength(content) <= 16_777_216, 'EVIDENCE_LIMIT', 'Captured evidence exceeds its storage limit.');
    return this.store.transaction(() => {
      this.store.require('rooms', roomId);
      const task = this.store.require('tasks', taskId);
      invariant(task.roomId === roomId, 'INVALID_REFERENCE', 'Evidence task belongs to another room.');
      const title = `Repository evidence: ${stream}`;
      const previous = this.store.list('artifacts', roomId).find(artifact => artifact.author === 'system' && artifact.title === title);
      const artifactId = previous?.artifactId ?? randomUUID();
      const versions = this.store.list('artifacts', roomId).filter(artifact => artifact.artifactId === artifactId);
      const version = Math.max(0, ...versions.map(artifact => artifact.version)) + 1;
      const ref = { artifactId, version };
      const id = `${artifactId}:${version}`;
      invariant(!this.store.get('artifacts', id), 'IMMUTABLE_EVIDENCE', 'Captured evidence already exists.');
      const artifact: ArtifactVersion = { id, ...ref, roomId, taskId, title, content, author: 'system', createdAt: new Date().toISOString() };
      this.store.put('artifacts', artifact);
      this.store.append({ id: randomUUID(), roomId, author: 'system', kind: 'artifact', body: `${title} · version ${version}`,
        taskId, artifactRefs: [ref], createdAt: artifact.createdAt });
      return ref;
    });
  }

  read(roomId: string, input: ArtifactRef): ArtifactVersion {
    const ref = artifactRefSchema.parse(input);
    const artifact = this.store.require('artifacts', `${ref.artifactId}:${ref.version}`);
    invariant(artifact.roomId === roomId, 'INVALID_REFERENCE', 'Artifact belongs to another room.');
    return artifact;
  }

  history(roomId: string, artifactId: string): ArtifactVersion[] {
    artifactRefSchema.parse({ artifactId, version: 1 });
    return this.store.list('artifacts', roomId).filter(artifact => artifact.artifactId === artifactId).sort((a, b) => a.version - b.version);
  }

  /** Bounded line replacement: common prefix/suffix preserved, no quadratic LCS allocation. */
  textDiff(roomId: string, before: ArtifactRef, after: ArtifactRef): string {
    const left = this.read(roomId, before); const right = this.read(roomId, after);
    invariant(left.artifactId === right.artifactId, 'INVALID_REFERENCE', 'Text history diff requires versions of one artifact.');
    invariant(left.content.length + right.content.length <= 200_000, 'EVIDENCE_LIMIT', 'Text diff exceeds its size limit.');
    const a = left.content.split('\n'); const b = right.content.split('\n');
    let start = 0; let end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    if (start === a.length && start === b.length) return '';
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const removed = a.slice(start, a.length - end); const added = b.slice(start, b.length - end);
    return [`--- version ${before.version}`, `+++ version ${after.version}`,
      `@@ -${removed.length ? start + 1 : start},${removed.length} +${added.length ? start + 1 : start},${added.length} @@`,
      ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join('\n');
  }
}
