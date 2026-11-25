import {
  askAnswerMeta,
  askChipsFromUrl,
  askPlaceholder,
  askSourceIcon,
  primaryAskContext,
  projectChip,
  taskChip,
  visibleAskChips,
  type AskContextLookup,
} from './ask-context';

const lookup: AskContextLookup = {
  issue: (ref) =>
    ref.toUpperCase() === 'TRM-128'
      ? { key: 'TRM-128', title: 'Rotate OAuth tokens before expiry', projectId: 'pj_web' }
      : undefined,
  project: (id) => (id === 'pj_web' ? { id, name: 'Web app' } : undefined),
  view: (id) => (id === 'vw_1' ? { id, name: 'My bugs' } : undefined),
};

describe('ask context from the route', () => {
  it('fills the task and its project on a task page', () => {
    const chips = askChipsFromUrl('/acme/tasks/TRM-128', lookup);
    expect(chips.map((c) => [c.kind, c.label])).toEqual([
      ['task', 'TRM-128'],
      ['project', 'Web app'],
    ]);
    expect(chips[0].context).toEqual({ kind: 'issue', id: 'TRM-128', label: 'TRM-128' });
    expect(chips[0].hint).toContain('Rotate OAuth tokens');
  });

  it('ignores the query string and decodes the id', () => {
    const chips = askChipsFromUrl('/acme/issues/TRM%2D128?tab=thread#top', lookup);
    expect(chips[0].id).toBe('task:TRM-128');
  });

  it('keeps the key as the label for a task that is not loaded', () => {
    const chips = askChipsFromUrl('/acme/tasks/TRM-999', lookup);
    expect(chips.map((c) => c.label)).toEqual(['TRM-999']);
  });

  it('fills the project on a project page', () => {
    const chips = askChipsFromUrl('/acme/projects/pj_web/updates', lookup);
    expect(chips).toHaveLength(1);
    expect(chips[0].context).toEqual({ kind: 'project', id: 'pj_web', label: 'Web app' });
  });

  it('fills the view name on a saved view', () => {
    const [chip] = askChipsFromUrl('/acme/views/vw_1', lookup);
    expect(chip.kind).toBe('view');
    expect(chip.label).toBe('My bugs');
    expect(chip.context.kind).toBe('page');
  });

  it('falls back to the page on lists and other screens', () => {
    expect(askChipsFromUrl('/acme/tasks', lookup)[0].label).toBe('Tasks');
    expect(askChipsFromUrl('/acme/overview', lookup)[0].label).toBe('Home');
    expect(askChipsFromUrl('/acme/settings/profile', lookup)[0].label).toBe('Settings');
    expect(askChipsFromUrl('/acme/some-new-page', lookup)[0].label).toBe('Some new page');
  });

  it('has nothing to fill outside a workspace', () => {
    expect(askChipsFromUrl('/', lookup)).toEqual([]);
    expect(askChipsFromUrl('', lookup)).toEqual([]);
  });
});

describe('visible chips', () => {
  const route = askChipsFromUrl('/acme/tasks/TRM-128', lookup);

  it('drops the chips the person removed', () => {
    const chips = visibleAskChips(route, new Set(['task:TRM-128']), []);
    expect(chips.map((c) => c.label)).toEqual(['Web app']);
  });

  it('appends added chips once, even when the route already has them', () => {
    const extra = taskChip({ key: 'TRM-131', title: 'Backfill' });
    const chips = visibleAskChips(route, new Set(), [extra, projectChip({ id: 'pj_web', name: 'Web app' })]);
    expect(chips.map((c) => c.id)).toEqual(['task:TRM-128', 'project:pj_web', 'task:TRM-131']);
  });
});

describe('what the assistant is told', () => {
  it('prefers the task, then the project, then the page', () => {
    const chips = askChipsFromUrl('/acme/tasks/TRM-128', lookup);
    expect(primaryAskContext(chips)?.kind).toBe('issue');
    expect(primaryAskContext(chips.slice(1))?.kind).toBe('project');
    expect(primaryAskContext(askChipsFromUrl('/acme/inbox', lookup))?.kind).toBe('page');
  });

  it('sends nothing once every chip is removed', () => {
    expect(primaryAskContext([])).toBeUndefined();
  });

  it('words the input after the subject', () => {
    expect(askPlaceholder('issue')).toBe('Ask about this task…');
    expect(askPlaceholder('project')).toBe('Ask about this project…');
    expect(askPlaceholder(undefined)).toBe('Ask about your records…');
  });
});

describe('answer sources', () => {
  it('picks an icon from what the label names', () => {
    expect(askSourceIcon('PR #482')).toBe('pr');
    expect(askSourceIcon('Thread · 4m')).toBe('thread');
    expect(askSourceIcon('Read TRM-131')).toBe('task');
    expect(askSourceIcon('Listed projects')).toBe('record');
  });

  it('counts read and changed steps, not notes', () => {
    const meta = askAnswerMeta([
      { kind: 'note', label: 'Looking at the task' },
      { kind: 'read', label: 'Read TRM-128' },
      { kind: 'read', label: 'Searched tasks', count: 3 },
    ]);
    expect(meta.records).toBe(4);
    expect(meta.sources.map((s) => s.label)).toEqual(['Read TRM-128', 'Searched tasks']);
    expect(askAnswerMeta(undefined)).toEqual({ records: 0, sources: [] });
  });
});
