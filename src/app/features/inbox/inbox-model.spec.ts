import type { Artifact, AttentionItem, Issue, Notification } from '../../core';
import { DAY } from '../stats/flow-stats';
import { LEGACY_TABS, buildInbox, taskKeyOf, tabOf, type InboxContext } from './inbox-model';

const NOW = Date.parse('2026-03-20T12:00:00Z');
const iso = (offsetDays: number): string => new Date(NOW + offsetDays * DAY).toISOString();

const issue = (id: string, patch: Partial<Issue> = {}): Issue =>
  ({
    id,
    workspaceId: 'w',
    key: `AH-${id}`,
    number: 1,
    kind: 'feature',
    title: `Task ${id}`,
    source: 'manual',
    priority: 'none',
    status: 'in_progress',
    milestoneIds: [],
    labels: [],
    aliases: [],
    createdAt: iso(-60),
    updatedAt: iso(-1),
    ...patch,
  }) as Issue;

const artifact = (id: string, patch: Partial<Artifact> = {}): Artifact =>
  ({
    id,
    kind: 'pull_request',
    provider: 'github',
    title: 'Fix the thing',
    externalId: '#12',
    url: 'https://example.test/pr/12',
    state: 'open',
    createdAt: iso(-3),
    updatedAt: iso(-1),
    ...patch,
  }) as Artifact;

const attention = (id: string, patch: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  kind: 'review_requested',
  severity: 'medium',
  title: 'Fix the thing',
  detail: '',
  issueId: '31',
  artifactId: 'a1',
  since: iso(-1),
  state: 'open',
  ...patch,
});

const notification = (id: string, patch: Partial<Notification> = {}): Notification =>
  ({
    id,
    workspaceId: 'w',
    kind: 'comment',
    title: 'Marco commented on AH-31: Task 31',
    body: 'Looks good to me',
    actor: { type: 'user', id: 'u2' },
    subject: { type: 'issue', id: '31' },
    link: 'tasks/AH-31',
    createdAt: iso(-0.5),
    ...patch,
  }) as Notification;

const issues = [issue('31'), issue('40', { updatedAt: iso(-20) }), issue('50', { status: 'todo' })];

const ctx: InboxContext = {
  now: NOW,
  issueById: new Map(issues.map((i) => [i.id, i])),
  artifactById: new Map([['a1', artifact('a1')], ['a2', artifact('a2', { kind: 'build', title: 'CI #8231', externalId: undefined })]]),
  actorName: () => 'Marco',
  activityAt: (i) => Date.parse(i.updatedAt),
  idleDays: 7,
};

const ids = (sections: ReturnType<typeof buildInbox>, id: string): string[] =>
  sections.find((s) => s.id === id)?.entries.map((e) => e.id) ?? [];

describe('buildInbox', () => {
  it('says why an attention item is there in one plain sentence', () => {
    const [action] = buildInbox(
      {
        attention: [
          attention('review'),
          attention('ci', { kind: 'ci_failed', severity: 'high', artifactId: 'a2', issueId: '40' }),
        ],
        mine: [],
        notifications: [],
      },
      ctx,
    );
    const sentence = (id: string) => action.entries.find((e) => e.id === id)?.sentence;
    expect(sentence('review')).toBe('Review requested on PR #12 for AH-31');
    expect(sentence('ci')).toBe('“CI #8231” is failing for AH-40');
  });

  it('puts the most severe first, then the newest', () => {
    const [action] = buildInbox(
      {
        attention: [
          attention('old', { since: iso(-5) }),
          attention('new', { since: iso(-1) }),
          attention('high', { severity: 'high', since: iso(-9) }),
        ],
        mine: [],
        notifications: [],
      },
      ctx,
    );
    expect(action.entries.map((e) => e.id)).toEqual(['high', 'new', 'old']);
  });

  it('opens a pull request from its row and falls back to the task', () => {
    const [action] = buildInbox(
      { attention: [attention('a'), attention('b', { artifactId: undefined })], mine: [], notifications: [] },
      ctx,
    );
    expect(action.entries.find((e) => e.id === 'a')?.primary).toMatchObject({ type: 'external', label: 'Review' });
    expect(action.entries.find((e) => e.id === 'b')?.primary).toMatchObject({ type: 'open' });
  });

  it('splits running tasks into in progress and stale, and leaves out todo', () => {
    const sections = buildInbox({ attention: [], mine: issues, notifications: [] }, ctx);
    expect(ids(sections, 'progress')).toEqual(['task:31']);
    expect(ids(sections, 'stale')).toEqual(['task:40']);
    expect(sections.find((s) => s.id === 'stale')?.entries[0].text).toBe('No activity for 20 days');
    expect(sections.find((s) => s.id === 'progress')?.entries[0].text).toBe('In progress');
  });

  it('does not repeat a task that already needs you', () => {
    const sections = buildInbox({ attention: [attention('review')], mine: issues, notifications: [] }, ctx);
    expect(ids(sections, 'progress')).toEqual([]);
  });

  it('lists snoozed and dismissed items apart, with a restore action', () => {
    const sections = buildInbox(
      { attention: [attention('s', { state: 'snoozed', snoozedUntil: iso(2) })], mine: [], notifications: [] },
      ctx,
    );
    expect(ids(sections, 'action')).toEqual([]);
    expect(sections.find((s) => s.id === 'later')?.entries[0].primary.type).toBe('restore');
  });

  it('turns notifications into sentences, newest first, and marks unread ones', () => {
    const sections = buildInbox(
      {
        attention: [],
        mine: [],
        notifications: [
          notification('n1', { createdAt: iso(-2), readAt: iso(-1) }),
          notification('n2', { kind: 'assigned', createdAt: iso(-0.1) }),
          notification('n3', { kind: 'review_requested' }),
        ],
      },
      ctx,
    );
    const updates = sections.find((s) => s.id === 'updates')!.entries;
    expect(updates.map((e) => e.id)).toEqual(['n2', 'n1']);
    expect(updates[0].sentence).toBe('Marco assigned you AH-31');
    expect(updates[1].sentence).toBe('Marco commented on AH-31');
    expect(updates[0].unread).toBe(true);
    expect(updates[1].unread).toBe(false);
  });

  it('files every entry under one tab and names its kind for the preview', () => {
    const sections = buildInbox(
      {
        attention: [attention('review'), attention('gone', { state: 'dismissed' })],
        mine: issues,
        notifications: [],
      },
      ctx,
    );
    const all = sections.flatMap((s) => s.entries);
    const tab = (id: string) => tabOf(all.find((e) => e.id === id)!);
    expect(tab('review')).toBe('sync');
    expect(tab('gone')).toBe('later');
    expect(tab('task:40')).toBe('records');
    expect(all.find((e) => e.id === 'review')?.kicker).toBe('Review requested');
    expect(all.find((e) => e.id === 'task:40')?.kicker).toBe('Stale');
  });

  it('maps old and current ?tab= values to a tab', () => {
    expect(LEGACY_TABS['needs-you']).toBe('sync');
    expect(LEGACY_TABS['tasks']).toBe('records');
    expect(LEGACY_TABS['updates']).toBe('mentions');
    expect(LEGACY_TABS['mentions']).toBe('mentions');
    expect(LEGACY_TABS['nope']).toBeUndefined();
  });

  it('always keeps the first section, even when empty', () => {
    expect(buildInbox({ attention: [], mine: [], notifications: [] }, ctx).map((s) => s.id)).toEqual(['action']);
  });
});

describe('taskKeyOf', () => {
  it('reads the task key of a notification link', () => {
    expect(taskKeyOf('tasks/AUTH-42')).toBe('AUTH-42');
    expect(taskKeyOf('/issues/AUTH-42?x=1')).toBe('AUTH-42');
    expect(taskKeyOf('projects/p1')).toBeUndefined();
  });
});
