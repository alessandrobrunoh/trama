import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_OPTIONS } from '../contracts/domain.js';
import {
  buildPreview,
  deriveTeamKey,
  githubIssueId,
  inferKind,
  mapGithubState,
  mapLinearPriority,
  mapLinearStateType,
  mappingFromPreview,
  parseExternalUrl,
  parseMapping,
  parseOptions,
  priorityFromLabels,
  redactSecrets,
  suggestStatus,
  suggestUser,
  toNewIssue,
  type ResolvedPlan,
} from './mapping.js';
import type { Discovery, ExternalIssue } from './types.js';

const members = [
  { id: 'u_ada', name: 'Ada Lovelace', email: 'ada@acme.dev' },
  { id: 'u_bob', name: 'Bob Stone', email: 'bob@acme.dev' },
  { id: 'u_bob2', name: 'Bob Stone', email: 'bob.stone@other.dev' },
];

describe('state and priority mapping', () => {
  it('maps Linear priorities (0 none, 1 urgent … 4 low)', () => {
    expect([0, 1, 2, 3, 4, null, undefined, 9].map(mapLinearPriority)).toEqual(['none', 'urgent', 'high', 'medium', 'low', 'none', 'none', 'none']);
  });

  it('maps Linear states by type, and a "review" column to in_review', () => {
    expect(mapLinearStateType('triage')).toBe('backlog');
    expect(mapLinearStateType('backlog')).toBe('backlog');
    expect(mapLinearStateType('unstarted')).toBe('todo');
    expect(mapLinearStateType('started', 'In Progress')).toBe('in_progress');
    expect(mapLinearStateType('started', 'Code Review')).toBe('in_review');
    expect(mapLinearStateType('completed')).toBe('done');
    expect(mapLinearStateType('canceled')).toBe('canceled');
    expect(mapLinearStateType('something-new')).toBe('backlog');
  });

  it('maps GitHub states: open stays unscheduled, closed is done, not planned is canceled', () => {
    expect(suggestStatus('github', mapGithubState('open'))).toBe('backlog');
    expect(suggestStatus('github', mapGithubState('closed', 'completed'))).toBe('done');
    expect(suggestStatus('github', mapGithubState('closed'))).toBe('done');
    expect(suggestStatus('github', mapGithubState('closed', 'not_planned'))).toBe('canceled');
  });

  it('reads a priority only from labels that look like one', () => {
    expect(priorityFromLabels(['bug', 'priority: high'])).toBe('high');
    expect(priorityFromLabels(['Priority/Low'])).toBe('low');
    expect(priorityFromLabels(['P0'])).toBe('urgent');
    expect(priorityFromLabels(['p2'])).toBe('medium');
    expect(priorityFromLabels(['critical'])).toBe('urgent');
    // a bare "high" or "low" could be anything
    expect(priorityFromLabels(['high', 'low', 'enhancement'])).toBeUndefined();
  });

  it('infers the kind from labels, falling back to the default', () => {
    expect(inferKind(['Bug'], 'feature')).toBe('bug');
    expect(inferKind(['area: api', 'security'], 'feature')).toBe('security');
    expect(inferKind(['chore'], 'feature')).toBe('tech_debt');
    expect(inferKind(['enhancement'], 'idea')).toBe('feature');
    expect(inferKind(['docs'], 'idea')).toBe('idea');
    expect(inferKind([], 'feedback')).toBe('feedback');
  });
});

describe('user mapping', () => {
  it('matches by email first', () => {
    expect(suggestUser({ id: 'x', email: 'BOB@acme.dev', login: 'someone' }, members)).toBe('u_bob');
  });

  it('matches a login against the email local part, then the display name', () => {
    expect(suggestUser({ id: 'ada', login: 'ada' }, members)).toBe('u_ada');
    expect(suggestUser({ id: 'x', name: 'Ada Lovelace' }, members)).toBe('u_ada');
  });

  it('refuses an ambiguous match instead of guessing', () => {
    // two members are called Bob Stone
    expect(suggestUser({ id: 'x', name: 'Bob Stone' }, members)).toBeNull();
    expect(suggestUser({ id: 'x', login: 'nobody' }, members)).toBeNull();
  });
});

describe('team keys', () => {
  it('uses the tracker key, avoids collisions and stays 2-8 uppercase letters or digits', () => {
    expect(deriveTeamKey('eng', 'Engineering', new Set())).toBe('ENG');
    expect(deriveTeamKey('eng', 'Engineering', new Set(['ENG']))).toBe('ENG2');
    expect(deriveTeamKey(undefined, 'Web Platform', new Set())).toBe('WEBPLA');
    expect(deriveTeamKey('1', '', new Set())).toMatch(/^[A-Z][A-Z0-9]{1,7}$/);
  });
});

describe('mapping validation', () => {
  it('accepts a well-formed mapping', () => {
    const m = parseMapping({
      teams: { t1: { action: 'create' } },
      projects: { p1: { action: 'map', id: 'pj_1' } },
      labels: { l1: { action: 'skip' } },
      users: { u1: 'usr_1', u2: null },
      statuses: { s1: 'in_review' },
    });
    expect(m.projects.p1).toEqual({ action: 'map', id: 'pj_1' });
    expect(m.users).toEqual({ u1: 'usr_1', u2: null });
    expect(m.statuses.s1).toBe('in_review');
  });

  it('treats a missing mapping as empty', () => {
    expect(parseMapping(undefined)).toEqual({ teams: {}, projects: {}, labels: {}, users: {}, statuses: {} });
  });

  it.each([
    ['a status that does not exist', { statuses: { s: 'finished' } }],
    ['a target without an action', { labels: { l: { id: 'x' } } }],
    ['map without an id', { projects: { p: { action: 'map' } } }],
    ['a user that is not a string or null', { users: { u: 5 } }],
    ['a list instead of an object', { teams: [] }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseMapping(raw)).toThrow(BadRequestException);
  });

  it('validates options', () => {
    expect(parseOptions({ includeComments: true }, DEFAULT_IMPORT_OPTIONS)).toEqual({ ...DEFAULT_IMPORT_OPTIONS, includeComments: true });
    expect(() => parseOptions({ defaultKind: 'epic' }, DEFAULT_IMPORT_OPTIONS)).toThrow(BadRequestException);
    expect(() => parseOptions({ includeClosed: 'yes' }, DEFAULT_IMPORT_OPTIONS)).toThrow(BadRequestException);
  });
});

describe('preview', () => {
  const discovery: Discovery = {
    provider: 'linear',
    account: 'Ada',
    sourceLabel: 'Acme: ENG',
    counts: { issues: 3, open: null, closed: null },
    teams: [{ id: 't1', key: 'ENG', name: 'Engineering' }],
    projects: [{ id: 'p1', name: 'Launch' }, { id: 'p2', name: 'New thing' }],
    labels: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'Sparkle' }],
    milestones: [],
    users: [{ id: 'lu1', name: 'Ada Lovelace', email: 'ada@acme.dev' }, { id: 'lu2', name: 'Ghost' }],
    statuses: [
      { id: 's1', name: 'Todo', type: 'unstarted' },
      { id: 's2', name: 'In Review', type: 'started' },
    ],
    sample: [],
    warnings: [],
  };
  const preview = buildPreview(discovery, {
    members,
    teams: [],
    projects: [{ id: 'pj_launch', name: 'launch' }],
    labels: [{ id: 'lb_bug', name: 'Bug' }],
  });

  it('suggests existing entities by name and creates the rest', () => {
    expect(preview.projects.map((p) => p.suggested)).toEqual([{ action: 'map', id: 'pj_launch' }, { action: 'create' }]);
    expect(preview.labels.map((l) => l.suggested)).toEqual([{ action: 'map', id: 'lb_bug' }, { action: 'create' }]);
    // a Linear team becomes a Trama team unless one with that key exists
    expect(preview.teams[0].suggested).toEqual({ action: 'create' });
    expect(preview.counts).toMatchObject({ issues: 3, projects: 2, labels: 2, users: 2 });
  });

  it('turns the suggestions into a mapping the service accepts as is', () => {
    const mapping = mappingFromPreview(preview);
    expect(mapping.users).toEqual({ lu1: 'u_ada', lu2: null });
    expect(mapping.statuses).toEqual({ s1: 'todo', s2: 'in_review' });
    expect(parseMapping(mapping)).toEqual(mapping);
  });
});

describe('issue conversion', () => {
  const plan: ResolvedPlan = {
    teams: { t1: 'tm_1' },
    projects: { p1: 'pj_1' },
    labels: { l1: 'lb_bug', l2: null },
    milestones: { m1: 'ms_1' },
    users: { a1: 'u_ada' },
    statuses: { s_review: 'in_review' },
  };
  const ext: ExternalIssue = {
    id: 'lin-uuid',
    key: 'ENG-7',
    url: 'https://linear.app/acme/issue/ENG-7/crash',
    title: '  Crash on save  ',
    body: 'Steps…',
    state: { id: 's_review', name: 'In Review', type: 'started' },
    priority: 'high',
    estimate: 3,
    labels: [{ id: 'l1', name: 'Bug' }, { id: 'l2', name: 'ignored' }],
    assignee: { id: 'a1', name: 'Ada' },
    creator: { id: 'c1', name: 'Carl' },
    teamId: 't1',
    projectId: 'p1',
    milestone: { id: 'm1', name: 'Beta' },
    createdAt: '2026-01-02T10:00:00.000Z',
    updatedAt: '2026-02-03T10:00:00.000Z',
    startedAt: '2026-01-05T10:00:00.000Z',
  };
  const now = new Date('2026-10-01T00:00:00Z');

  it('maps every field through the plan', () => {
    const n = toNewIssue('linear', ext, plan, DEFAULT_IMPORT_OPTIONS, now);
    expect(n).toMatchObject({
      title: 'Crash on save',
      kind: 'bug',
      source: 'linear',
      status: 'in_review',
      priority: 'high',
      estimate: 3,
      assigneeId: 'u_ada',
      teamId: 'tm_1',
      projectId: 'pj_1',
      milestoneIds: ['ms_1'],
      labels: ['lb_bug'],
      reporterName: 'Carl',
    });
    expect(n.createdAt.toISOString()).toBe('2026-01-02T10:00:00.000Z');
    expect(n.startedAt?.toISOString()).toBe('2026-01-05T10:00:00.000Z');
    expect(n.completedAt).toBeNull();
    expect(n.externalRef).toMatchObject({ provider: 'linear', id: 'lin-uuid', key: 'ENG-7', state: 'In Review', stateType: 'in_progress', origin: 'import' });
  });

  it('leaves skipped and unknown references unset and falls back for unmapped states', () => {
    const n = toNewIssue(
      'linear',
      { ...ext, assignee: { id: 'unknown' }, teamId: 'tX', projectId: 'pX', milestone: undefined, state: { id: 'new', name: 'Done', type: 'completed' }, closedAt: '2026-03-01T00:00:00.000Z' },
      plan,
      DEFAULT_IMPORT_OPTIONS,
      now,
    );
    expect(n).toMatchObject({ assigneeId: null, teamId: null, projectId: null, milestoneIds: [], status: 'done' });
    expect(n.completedAt?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('clamps the title and ignores a negative estimate', () => {
    const n = toNewIssue('github', { ...ext, title: 'x'.repeat(500), estimate: -1 }, plan, DEFAULT_IMPORT_OPTIONS, now);
    expect(n.title).toHaveLength(300);
    expect(n.estimate).toBeNull();
    expect(n.source).toBe('github');
  });
});

describe('external URLs', () => {
  it('reads GitHub issue and pull request URLs', () => {
    expect(parseExternalUrl('https://github.com/Acme/api/issues/12')).toMatchObject({ provider: 'github', host: 'github.com', repository: 'Acme/api', number: 12 });
    expect(parseExternalUrl('https://github.com/acme/api/pull/9?x=1#y')).toMatchObject({ number: 9, url: 'https://github.com/acme/api/issues/9' });
    expect(githubIssueId('Acme/API', 12)).toBe('acme/api#12');
  });

  it('reads Linear URLs', () => {
    expect(parseExternalUrl('https://linear.app/acme/issue/eng-123/some-slug')).toMatchObject({ provider: 'linear', identifier: 'ENG-123' });
  });

  it('refuses anything else, including credentials in the URL', () => {
    expect(parseExternalUrl('https://github.com/acme/api')).toBeNull();
    expect(parseExternalUrl('ftp://github.com/acme/api/issues/1')).toBeNull();
    expect(parseExternalUrl('https://user:pw@github.com/acme/api/issues/1')).toBeNull();
    expect(parseExternalUrl('not a url')).toBeNull();
    expect(parseExternalUrl('https://linear.app/acme/projects/x')).toBeNull();
  });
});

describe('secret redaction', () => {
  it('removes the given secret wherever it appears', () => {
    const token = 'tok_1234567890abcdef';
    expect(redactSecrets(`GET failed for ${token} (${token})`, [token])).toBe('GET failed for [redacted] ([redacted])');
  });

  it('removes anything shaped like a GitHub or Linear token or an auth header', () => {
    const gh = `ghp_${'a'.repeat(36)}`;
    const lin = `lin_api_${'b'.repeat(40)}`;
    const out = redactSecrets(`token ${gh} key ${lin} Authorization: Bearer abcdefghijkl`);
    expect(out).not.toContain(gh);
    expect(out).not.toContain(lin);
    expect(out).not.toContain('abcdefghijkl');
  });

  it('ignores empty or very short secrets instead of mangling the text', () => {
    expect(redactSecrets('hello world', ['', null, 'a'])).toBe('hello world');
  });
});
