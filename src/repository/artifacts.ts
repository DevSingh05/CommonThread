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

}
