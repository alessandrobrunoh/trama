import type { ArtifactKind, ArtifactProvider } from '../contracts/domain.js';

/** What an artifact needs to know about a pull / merge request, read from its URL. */
export interface PullRequestRef {
  kind: Extract<ArtifactKind, 'pull_request' | 'merge_request'>;
  provider: ArtifactProvider;
  /** `owner/name` of the repository, when the URL shows it. */
  repository: string | null;
  /** `#423` (GitHub, Bitbucket) or `!17` (GitLab). */
  externalId: string | null;
  title: string;
}

const TITLE_MAX = 200;

/**
 * Reads `https://github.com/acme/web/pull/423`, `https://gitlab.com/acme/web/-/merge_requests/17` and
 * `https://bitbucket.org/acme/web/pull-requests/9`. Any other URL is a pull request of an unknown
 * provider, titled after the URL.
 */
export function parsePullRequestUrl(raw: string): PullRequestRef {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'pull_request', provider: 'other', repository: null, externalId: null, title: raw.slice(0, TITLE_MAX) };
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');

  const github = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/.exec(path);
  if (github && (host === 'github.com' || host.startsWith('github.')))
    return {
      kind: 'pull_request',
      provider: 'github',
      repository: github[1],
      externalId: `#${github[2]}`,
      title: `${github[1]}#${github[2]}`,
    };

  const gitlab = /^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:\/|$)/.exec(path);
  if (gitlab && host.includes('gitlab'))
    return {
      kind: 'merge_request',
      provider: 'gitlab',
      repository: gitlab[1],
      externalId: `!${gitlab[2]}`,
      title: `${gitlab[1]}!${gitlab[2]}`,
    };

  const bitbucket = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/.exec(path);
  if (bitbucket && host.includes('bitbucket'))
    return {
      kind: 'pull_request',
      provider: 'bitbucket',
      repository: bitbucket[1],
      externalId: `#${bitbucket[2]}`,
      title: `${bitbucket[1]}#${bitbucket[2]}`,
    };

  return {
    kind: 'pull_request',
    provider: 'other',
    repository: null,
    externalId: null,
    title: `${url.host}${path}`.slice(0, TITLE_MAX),
  };
}
