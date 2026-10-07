import type { ArtifactKind, ArtifactProvider, ArtifactState, CiState, ReviewState } from '../contracts/domain.js';
export interface ArtifactCandidate {
    kind: Extract<ArtifactKind, 'pull_request' | 'merge_request'>;
    provider: Extract<ArtifactProvider, 'github' | 'gitlab'>;
    externalId: string;
    title: string;
    url?: string;
    state?: ArtifactState;
    ci?: CiState;
    review?: ReviewState;
    hasConflicts?: boolean;
    headSha?: string;
    headBranch?: string;
    texts: string[];
    branchTexts: string[];
    reviewOnlyFrom?: ReviewState[];
}
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
