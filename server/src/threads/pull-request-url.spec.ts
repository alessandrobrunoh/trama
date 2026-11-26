import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from './pull-request-url.js';

describe('parsePullRequestUrl', () => {
  it('reads a GitHub pull request', () => {
    expect(parsePullRequestUrl('https://github.com/acme/web/pull/423')).toEqual({
      kind: 'pull_request',
      provider: 'github',
      repository: 'acme/web',
      externalId: '#423',
      title: 'acme/web#423',
    });
    expect(parsePullRequestUrl('https://github.com/acme/web/pull/423/files?x=1').externalId).toBe('#423');
  });

  it('reads a GitLab merge request, including groups', () => {
    expect(parsePullRequestUrl('https://gitlab.com/acme/platform/web/-/merge_requests/17')).toEqual({
      kind: 'merge_request',
      provider: 'gitlab',
      repository: 'acme/platform/web',
      externalId: '!17',
      title: 'acme/platform/web!17',
    });
  });

  it('reads a Bitbucket pull request', () => {
    expect(parsePullRequestUrl('https://bitbucket.org/acme/web/pull-requests/9').provider).toBe('bitbucket');
  });

  it('keeps any other URL as a pull request of an unknown provider', () => {
    expect(parsePullRequestUrl('https://git.example.com/review/42/')).toEqual({
      kind: 'pull_request',
      provider: 'other',
      repository: null,
      externalId: null,
      title: 'git.example.com/review/42',
    });
  });
});
