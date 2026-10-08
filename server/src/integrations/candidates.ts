import type { ArtifactKind, ArtifactProvider, ArtifactState, CiState, ReviewState } from '../contracts/domain.js';

/**
 * A normalized PR/MR as reported by a webhook (or, later, a sync). Fields left
 * `undefined` are not touched on existing artifacts and defaulted on new ones.
 */
export interface ArtifactCandidate {
  kind: Extract<ArtifactKind, 'pull_request' | 'merge_request'>;
  provider: Extract<ArtifactProvider, 'github' | 'gitlab' | 'bitbucket'>;
  /** `#182` (GitHub, Bitbucket) / `!12` (GitLab). */
  externalId: string;
  title: string;
  url?: string;
  state?: ArtifactState;
  ci?: CiState;
  review?: ReviewState;
  hasConflicts?: boolean;
  headSha?: string;
  headBranch?: string;
  /** Free text scanned (case-sensitively) for workstream keys: title, body. */
  texts: string[];
  /** Branch names, scanned case-insensitively (`auth-42/replay`). */
  branchTexts: string[];
  /** Only apply `review` when the artifact's current review is one of these. */
  reviewOnlyFrom?: ReviewState[];
}

/** CI result for a commit; applied to every PR/MR whose head is `sha` (or listed explicitly). */
export interface CiPatch {
  sha?: string;
  prExternalIds?: string[];
  ci: CiState;
}

export interface RepoMeta {
  fullName: string;
  url?: string;
  defaultBranch?: string;
}
