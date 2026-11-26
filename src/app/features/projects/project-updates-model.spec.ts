import type { ActorRef, DomainEvent, Issue, Milestone, ProjectUpdate } from '../../core';
import {
  castOf,
  changelogMarkdown,
  deriveKeyEvents,
  firstParagraph,
  milestoneWindows,
  newUpdatesCount,
  plainText,
  recapOf,
  restOfBody,
  type UpdatesContext,
} from './project-updates-model';

const at = (iso: string): string => new Date(`${iso}T12:00:00`).toISOString();
const ana: ActorRef = { type: 'user', id: 'u1' };
const bot: ActorRef = { type: 'agent', id: 'a1' };

const issue = (id: string, patch: Partial<Issue> = {}): Issue =>
  ({
    id,
    workspaceId: 'w',
    key: `TRM-${id}`,
    number: 1,
    kind: 'feature',
    title: `Task ${id}`,
    source: 'manual',
    priority: 'none',
    status: 'todo',
    milestoneIds: ['m2'],
    labels: [],
    aliases: [],
    createdAt: at('2026-11-01'),
    updatedAt: at('2026-11-01'),
    ...patch,
  }) as Issue;

const milestone = (id: string, targetDate: string, sortOrder: number): Milestone =>
  ({ id, workspaceId: 'w', projectId: 'p', name: `Milestone ${id}`, targetDate: at(targetDate), sortOrder }) as Milestone;

const event = (id: string, type: string, when: string, subjectId: string, data: Record<string, unknown> = {}, subject = 'issue'): DomainEvent =>
  ({
    id,
    workspaceId: 'w',
    at: at(when),
    actor: ana,
    type,
    subject: { type: subject, id: subjectId },
    data,
  }) as DomainEvent;

const update = (id: string, when: string, body: string, patch: Partial<ProjectUpdate> = {}): ProjectUpdate => ({
  id,
  workspaceId: 'w',
  projectId: 'p',
  author: ana,
  body,
  createdAt: at(when),
  ...patch,
});

const names: Record<string, string> = { u1: 'Ana', a1: 'Delta agent' };

function context(patch: Partial<UpdatesContext> = {}): UpdatesContext {
  return {
    project: { id: 'p', createdAt: at('2026-10-01') },
    milestones: [milestone('m1', '2026-11-10', 0), milestone('m2', '2026-12-10', 1)],
    issues: [
      issue('1', { milestoneIds: ['m1'], status: 'done', startedAt: at('2026-10-05'), completedAt: at('2026-11-12') }),
      issue('2', { startedAt: at('2026-11-15'), status: 'in_progress', estimate: 3 }),
      issue('3', { createdAt: at('2026-11-20') }),
    ],
    events: [],
    artifactById: new Map(),
    updates: [],
    points: false,
    currentMilestoneId: 'm2',
    actorName: (a) => names[a.id ?? ''] ?? 'Trama',
    statusName: (s) => s.replaceAll('_', ' '),
    isDoneStatus: (s) => s === 'done',
    healthName: (h) => h.replaceAll('_', ' '),
    ...patch,
  };
}

describe('plain text of an update', () => {
  const body = '## Status\n\nWe **shipped** the [beta](https://x.dev).\n\n- one\n- two';
  it('takes the first paragraph as the headline', () => {
    expect(firstParagraph(body)).toBe('Status');
    expect(firstParagraph('We **shipped** the [beta](https://x.dev).\n\nMore.')).toBe('We shipped the beta.');
  });
  it('keeps the rest apart', () => {
    expect(restOfBody('One.\n\nTwo.\n\nThree.')).toBe('Two. Three.');
    expect(restOfBody('One.')).toBe('');
  });
  it('drops code blocks and list marks', () => {
    expect(plainText('- a\n```\ncode\n```\n- b')).toBe('a b');
  });
});

describe('milestoneWindows', () => {
  it('starts each milestone where the previous one ended', () => {
    const w = milestoneWindows({ createdAt: at('2026-10-01') }, context().milestones);
    expect(w.map((x) => x.endDay! - x.startDay)).toEqual([40, 30]);
    expect(w[1].startDay).toBe(w[0].endDay);
  });
});

describe('deriveKeyEvents', () => {
  it('writes status changes and highlights tasks added once work had started', () => {
    const rows = deriveKeyEvents(
      context({
        events: [
          event('e1', 'issue.status_changed', '2026-11-16', '2', { to: 'in_progress' }),
          event('e2', 'issue.status_changed', '2026-11-12', '1', { to: 'done' }),
          event('e3', 'issue.created', '2026-11-20', '3'),
        ],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(['e3', 'e1', 'e2']);
    expect(rows[0]).toMatchObject({ kicker: 'SCOPE CHANGE', milestoneId: 'm2', ref: 'TRM-3' });
    expect(rows[0].text).toBe('Scope grew by 1 task when “Task 3” was added to the milestone.');
    expect(rows[1].text).toBe('Ana moved “Task 2” to in progress.');
    expect(rows[2]).toMatchObject({ text: 'Ana completed “Task 1”.', milestoneId: 'm1' });
  });

  it('counts the scope change in points when the project uses them', () => {
    const rows = deriveKeyEvents(
      context({
        points: true,
        issues: [issue('2', { startedAt: at('2026-11-15'), estimate: 3 }), issue('4', { estimate: 5 })],
        events: [event('e1', 'issue.updated', '2026-11-18', '4', { fields: ['milestoneIds'] })],
      }),
    );
    expect(rows[0].text).toBe('Scope grew by 5 points when “Task 4” was added to the milestone.');
  });

  it('does not call it a scope change before the work started', () => {
    const rows = deriveKeyEvents(
      context({ events: [event('e1', 'issue.created', '2026-11-12', '3')] }),
    );
    expect(rows[0].kicker).toBeUndefined();
    expect(rows[0].text).toBe('Ana opened “Task 3”.');
  });

  it('reads pull requests and ignores events of other projects', () => {
    const rows = deriveKeyEvents(
      context({
        events: [
          { ...event('e1', 'artifact.attached', '2026-11-16', 'ar1', { issueId: '2', kind: 'pull_request', externalId: '#482', title: 'Rotate tokens' }, 'artifact'), actor: bot },
          event('e2', 'issue.status_changed', '2026-11-16', 'other', { to: 'done' }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Delta agent opened PR #482, “Rotate tokens”, on TRM-2.');
  });

  it('puts posted updates in the milestone of their day and keeps one that was deleted', () => {
    const u = update('pu1', '2026-11-25', 'On track.\n\nDetails.', { health: 'on_track' });
    const rows = deriveKeyEvents(
      context({
        updates: [u],
        events: [
          event('e1', 'project.update_posted', '2026-11-25', 'p', { updateId: 'pu1', excerpt: 'On track.' }, 'project'),
          event('e2', 'project.update_posted', '2026-11-26', 'p', { updateId: 'gone', excerpt: 'Old news.', health: null }, 'project'),
        ],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(['e2', 'update:pu1']);
    expect(rows[1]).toMatchObject({ milestoneId: 'm2', text: 'Ana posted an update (on track): On track.' });
    expect(rows[1].update).toBe(u);
    expect(rows[0].text).toBe('Ana posted an update: Old news.');
  });
});

describe('castOf', () => {
  it('lists the lead first, then the busiest, counting pull requests', () => {
    const cast = castOf(
      context({
        events: [
          event('e1', 'issue.status_changed', '2026-11-16', '2', { to: 'done' }),
          { ...event('e2', 'artifact.attached', '2026-11-16', 'ar1', { issueId: '2', kind: 'pull_request' }, 'artifact'), actor: bot },
          { ...event('e3', 'issue.created', '2026-11-16', '3'), actor: bot },
        ],
      }),
      'lead',
    );
    expect(cast.map((c) => c.actor.id)).toEqual(['lead', 'a1', 'u1']);
    expect(cast[1]).toMatchObject({ events: 2, prs: 1 });
  });
});

describe('newUpdatesCount', () => {
  const list = [update('a', '2026-11-20', 'x'), update('b', '2026-11-22', 'y'), update('c', '2026-11-24', 'z', { author: { type: 'user', id: 'me' } })];
  it('counts what others posted since the tab was last open', () => {
    expect(newUpdatesCount(list, at('2026-11-21'), 'me')).toBe(1);
    expect(newUpdatesCount(list, at('2026-11-23'), 'me')).toBe(0);
  });
  it('counts every update by others when the tab was never open', () => {
    expect(newUpdatesCount(list, null, 'me')).toBe(2);
  });
});

describe('recapOf', () => {
  const ms = milestone('m1', '2026-11-10', 0);
  it('prefers the latest update of the milestone', () => {
    expect(recapOf(ms, [], [update('a', '2026-11-09', 'Wrapped up.\n\nMore.')])).toBe('Wrapped up.');
  });
  it('else counts what shipped against the target', () => {
    const done = [issue('1', { status: 'done', completedAt: at('2026-11-13') }), issue('2', { status: 'done', completedAt: at('2026-11-12') })];
    expect(recapOf(ms, done, [])).toBe('Shipped 2 tasks, 3 days late.');
    expect(recapOf(ms, [], [])).toBe('Closed without shipping a task.');
  });
});

describe('changelogMarkdown', () => {
  it('lists the updates newest first and the closed tasks per milestone', () => {
    const md = changelogMarkdown({
      project: { name: 'Web app' },
      updates: [update('b', '2026-11-22', 'Second.', { health: 'at_risk' }), update('a', '2026-11-20', 'First.')],
      milestones: context().milestones,
      issues: context().issues,
      authorName: (a) => names[a.id ?? ''] ?? 'Trama',
      healthName: (h) => h.replaceAll('_', ' '),
      now: new Date('2026-11-26T12:00:00'),
    });
    expect(md.startsWith('# Web app changelog\n')).toBe(true);
    expect(md.indexOf('Second.')).toBeLessThan(md.indexOf('First.'));
    expect(md).toContain('### Nov 22 · Ana · at risk');
    expect(md).toContain('### Milestone m1 (target Nov 10)\n\n- TRM-1 Task 1 (Nov 12)');
    expect(md).not.toContain('Milestone m2');
    expect(md.endsWith('\n')).toBe(true);
  });
});
