export { createRepositoryGuard, LocalRepositoryGuard, type GuardOptions } from './guard.js';
export { RepositoryArtifacts } from './artifacts.js';
export { canonicalizeRepository, captureStableSnapshot, changesBetween, validateRelativePath,
  type RepositoryIdentity, type RepositorySnapshot, type CaptureLimits, type FileChange } from './snapshot.js';
