import {
  SourceInputError,
  filterKey,
  filtersMatch,
  filtersOverlap,
  hostOfConnection,
  normalizeFilters,
  normalizeSourcePath,
  parseRepositoryReference,
  parseSourceInput,
  sourceIncludes,
  sourcesOverlap,
  specificity,
} from './source-path.js';

describe('parseSourceInput', () => {
  it('reads owner/name, web URLs and ssh remotes', () => {
    expect(parseSourceInput(' acme/web ')).toEqual({ host: undefined, path: 'acme/web' });
    expect(parseSourceInput('https://github.com/acme/web.git')).toEqual({ host: 'github.com', path: 'acme/web' });
    expect(parseSourceInput('https://GitLab.com/client-group/')).toEqual({ host: 'gitlab.com', path: 'client-group' });
    expect(parseSourceInput('git@github.com:acme/web.git')).toEqual({ host: 'github.com', path: 'acme/web' });
    expect(parseSourceInput('https://gitlab.com/client-group/*')).toEqual({ host: 'gitlab.com', path: 'client-group/*' });
  });
});

describe('normalizeSourcePath', () => {
  it('accepts a repository and an owner wildcard on GitHub', () => {
    expect(normalizeSourcePath('github', 'acme/web')).toBe('acme/web');
    expect(normalizeSourcePath('github', 'acme/.github')).toBe('acme/.github');
    expect(normalizeSourcePath('github', 'acme/*')).toBe('acme/*');
  });
  it('nests groups on GitLab', () => {
    expect(normalizeSourcePath('gitlab', 'client/team/app')).toBe('client/team/app');
    expect(normalizeSourcePath('gitlab', 'client/*')).toBe('client/*');
    expect(normalizeSourcePath('gitlab', 'client/team/*')).toBe('client/team/*');
  });
  it('rejects shapes the host does not have', () => {
    expect(() => normalizeSourcePath('github', 'acme')).toThrow(SourceInputError);
    expect(() => normalizeSourcePath('github', 'a/b/c')).toThrow(SourceInputError);
    expect(() => normalizeSourcePath('github', 'a/b/*')).toThrow(SourceInputError);
    expect(() => normalizeSourcePath('gitlab', 'solo')).toThrow(SourceInputError);
    expect(() => normalizeSourcePath('github', 'acme/we b')).toThrow(SourceInputError);
    expect(() => normalizeSourcePath('github', 'acme/..')).toThrow(SourceInputError);
    expect(() => normalizeSourcePath('github', '')).toThrow(SourceInputError);
  });
});

describe('source overlap', () => {
  it('compares repositories, groups and repositories inside a group', () => {
    expect(sourcesOverlap('acme/web', 'ACME/Web')).toBe(true);
    expect(sourcesOverlap('acme/web', 'acme/api')).toBe(false);
    expect(sourcesOverlap('acme/*', 'acme/web')).toBe(true);
    expect(sourcesOverlap('acme/web', 'acme/*')).toBe(true);
    expect(sourcesOverlap('acme/*', 'other/web')).toBe(false);
    expect(sourcesOverlap('acme/*', 'acme/*')).toBe(true);
    expect(sourcesOverlap('client/*', 'client/team/*')).toBe(true);
    expect(sourcesOverlap('client/a/*', 'client/b/*')).toBe(false);
  });
  it('does not confuse a name prefix with a group', () => {
    expect(sourcesOverlap('acme/*', 'acme-labs/web')).toBe(false);
    expect(sourceIncludes('acme/*', 'acme-labs/web')).toBe(false);
    expect(sourceIncludes('acme/*', 'Acme/Web')).toBe(true);
  });
});

describe('filters', () => {
  it('cleans and canonicalises', () => {
    expect(normalizeFilters({ labels: [' bug ', 'BUG', ''], milestone: ' v1 ' })).toEqual({ labels: ['bug'], milestone: 'v1' });
    expect(normalizeFilters(undefined)).toEqual({});
    expect(filterKey({})).toBe('');
    expect(filterKey({ labels: ['B', 'a'], milestone: 'V1' })).toBe(filterKey({ labels: ['a', 'b'], milestone: 'v1' }));
    expect(() => normalizeFilters({ labels: Array.from({ length: 11 }, (_, i) => `l${i}`) })).toThrow(SourceInputError);
  });
  it('overlaps unless two milestones differ', () => {
    expect(filtersOverlap({}, { labels: ['bug'] })).toBe(true);
    expect(filtersOverlap({ labels: ['bug'] }, { labels: ['feature'] })).toBe(true);
    expect(filtersOverlap({ milestone: 'v1' }, { milestone: 'V1' })).toBe(true);
    expect(filtersOverlap({ milestone: 'v1' }, { milestone: 'v2' })).toBe(false);
  });
  it('matches items on every filter', () => {
    expect(filtersMatch({}, { labels: [] })).toBe(true);
    expect(filtersMatch({ labels: ['bug'] }, { labels: ['Bug', 'ui'] })).toBe(true);
    expect(filtersMatch({ labels: ['bug', 'ui'] }, { labels: ['bug'] })).toBe(false);
    expect(filtersMatch({ milestone: 'v1' }, { labels: [], milestone: 'V1' })).toBe(true);
    expect(filtersMatch({ milestone: 'v1' }, { labels: [] })).toBe(false);
  });
  it('prefers a repository to a group and more filters to fewer', () => {
    const repo = specificity({ sourcePath: 'acme/web', filters: {} });
    const group = specificity({ sourcePath: 'acme/*', filters: { labels: ['a', 'b'] } });
    expect(repo).toBeGreaterThan(group);
    expect(specificity({ sourcePath: 'acme/web', filters: { labels: ['bug'] } })).toBeGreaterThan(repo);
    expect(specificity({ sourcePath: 'c/team/*', filters: {} })).toBeGreaterThan(specificity({ sourcePath: 'c/*', filters: {} }));
  });
});

describe('connection host', () => {
  it('uses the base URL host, else the public host', () => {
    expect(hostOfConnection('github', null)).toBe('github.com');
    expect(hostOfConnection('gitlab', 'https://git.client.io/')).toBe('git.client.io');
    expect(hostOfConnection('github', 'https://ghe.acme.com/api/v3')).toBe('ghe.acme.com');
  });
});

describe('parseRepositoryReference', () => {
  it('treats owner/name as GitHub', () => {
    expect(parseRepositoryReference('acme/web')).toEqual({ provider: 'github', host: 'github.com', path: 'acme/web' });
    expect(parseRepositoryReference('  acme/web  ')).toEqual({ provider: 'github', host: 'github.com', path: 'acme/web' });
  });
  it('reads URLs and says which host they are', () => {
    expect(parseRepositoryReference('https://github.com/acme/web/pull/3')).toEqual({ provider: 'github', host: 'github.com', path: 'acme/web' });
    expect(parseRepositoryReference('https://gitlab.com/client/team/app.git')).toEqual({ provider: 'gitlab', host: 'gitlab.com', path: 'client/team/app' });
    expect(parseRepositoryReference('git@bitbucket.org:acme/web.git')).toEqual({ provider: 'bitbucket', host: 'bitbucket.org', path: 'acme/web' });
    expect(parseRepositoryReference('https://gitlab.acme.io/g/p')).toEqual({ provider: 'gitlab', host: 'gitlab.acme.io', path: 'g/p' });
  });
  it('skips what it cannot place', () => {
    expect(parseRepositoryReference('')).toBeNull();
    expect(parseRepositoryReference(null)).toBeNull();
    expect(parseRepositoryReference('acme')).toBeNull();
    expect(parseRepositoryReference('https://example.com/acme/web')).toBeNull();
  });
});
