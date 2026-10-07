import type { CiState } from '../contracts/domain.js';
import type { ArtifactCandidate, CiPatch, RepoMeta } from '../integrations/candidates.js';
export declare class PayloadError extends Error {
}
export type ParsedEvent = {
    kind: 'ignored';
    reason: string;
} | {
    kind: 'ping';
} | {
    kind: 'pr';
    repo: RepoMeta;
    candidate: ArtifactCandidate;
} | {
    kind: 'ci';
    repo: RepoMeta;
    patch: CiPatch;
};
export declare function githubCi(status: unknown, conclusion: unknown): CiState;
export declare function parseGithubEvent(event: string, payload: unknown): ParsedEvent;
export declare function gitlabCi(status: unknown): CiState;
export declare function parseGitlabEvent(payload: unknown): ParsedEvent;
