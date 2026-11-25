import {
  addFilterTerm,
  connectionTag,
  filterTerms,
  filterText,
  parseFilterTerm,
  reconnectSection,
  removeFilterTerm,
  ruleActivity,
  ruleErrorSince,
  sourceProviders,
  suggestionNote,
  suggestionPickable,
  supportsTwoWay,
} from './source-model';

describe('parseFilterTerm', () => {
  it('reads label and milestone terms, and treats a bare word as a label', () => {
    expect(parseFilterTerm('label = frontend')).toEqual({ kind: 'label', value: 'frontend' });
    expect(parseFilterTerm('Label:bug')).toEqual({ kind: 'label', value: 'bug' });
    expect(parseFilterTerm('milestone = v1.2')).toEqual({ kind: 'milestone', value: 'v1.2' });
    expect(parseFilterTerm('  needs triage ')).toEqual({ kind: 'label', value: 'needs triage' });
    expect(parseFilterTerm('label = "good first issue"')).toEqual({ kind: 'label', value: 'good first issue' });
  });

  it('rejects an empty or oversized term', () => {
    expect(parseFilterTerm('')).toBeNull();
    expect(parseFilterTerm('label =  ')).toBeNull();
    expect(parseFilterTerm('x'.repeat(101))).toBeNull();
  });
});

describe('filters', () => {
  it('adds a label once, ignoring case, and lets a milestone replace the previous one', () => {
    let f = addFilterTerm({}, { kind: 'label', value: 'Bug' });
    f = addFilterTerm(f, { kind: 'label', value: 'bug' });
    f = addFilterTerm(f, { kind: 'milestone', value: 'v1' });
    f = addFilterTerm(f, { kind: 'milestone', value: 'v2' });
    expect(f).toEqual({ labels: ['Bug'], milestone: 'v2' });
  });

  it('stops at the label limit', () => {
    let f = {};
    for (let i = 0; i < 12; i++) f = addFilterTerm(f, { kind: 'label', value: `l${i}` });
    expect(filterTerms(f)).toHaveLength(10);
  });

  it('removes a term and drops the emptied key', () => {
    const f = { labels: ['a', 'b'], milestone: 'v1' };
    expect(removeFilterTerm(f, { kind: 'label', value: 'a' })).toEqual({ labels: ['b'], milestone: 'v1' });
    expect(removeFilterTerm({ labels: ['a'] }, { kind: 'label', value: 'a' })).toEqual({});
    expect(removeFilterTerm(f, { kind: 'milestone', value: 'v1' })).toEqual({ labels: ['a', 'b'] });
  });

  it('lists terms as chips', () => {
    expect(filterTerms({ labels: ['bug'], milestone: 'v1' }).map(filterText)).toEqual(['label = bug', 'milestone = v1']);
    expect(filterTerms(undefined)).toEqual([]);
  });
});

describe('wording', () => {
  const ago = (iso: string) => `ago(${iso})`;

  it('tags a connection by who owns it', () => {
    expect(connectionTag({ ownerType: 'workspace' })).toBe('workspace');
    expect(connectionTag({ ownerType: 'user', ownerName: 'Alessandro' })).toBe('personal · Alessandro');
    expect(connectionTag({ ownerType: 'user' })).toBe('personal');
    expect(connectionTag(undefined)).toBe('');
  });

  it('describes activity and errors', () => {
    expect(ruleActivity({ lastSyncAt: 't', taskCount: 14 }, ago)).toBe('ago(t) · 14 tasks');
    expect(ruleActivity({ lastSyncAt: 't', taskCount: 1 }, ago)).toBe('ago(t) · 1 task');
    expect(ruleActivity({ taskCount: 0 }, ago)).toBe('no tasks yet');
    expect(ruleActivity({ taskCount: 3 }, ago)).toBe('3 tasks');
    expect(ruleErrorSince({ lastSyncAt: 't' }, ago)).toBe('last sync ago(t)');
    expect(ruleErrorSince({}, ago)).toBe('never synced');
  });

  it('captions suggestions and only lets an available one be picked', () => {
    expect(suggestionNote('available')).toBe('available');
    expect(suggestionNote('this_project')).toBe('→ this project');
    expect(suggestionNote('other_project', 'Shop')).toBe('→ Shop already');
    expect(suggestionPickable('available')).toBe(true);
    expect(suggestionPickable('this_project')).toBe(false);
    expect(suggestionPickable('other_project')).toBe(false);
  });

  it('sends a person to the settings that hold the connection', () => {
    expect(reconnectSection({ ownerType: 'user' })).toBe('my-integrations');
    expect(reconnectSection({ ownerType: 'workspace' })).toBe('integrations');
    expect(reconnectSection(undefined)).toBe('integrations');
  });
});

describe('providers', () => {
  it('offers git hosts and only promises two-way where it is built', () => {
    expect(sourceProviders()).toEqual(['github', 'gitlab', 'bitbucket']);
    expect(supportsTwoWay('github')).toBe(true);
    expect(supportsTwoWay('gitlab')).toBe(true);
    expect(supportsTwoWay('bitbucket')).toBe(false);
  });
});
