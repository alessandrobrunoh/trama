import { describe, expect, it } from 'vitest';
import { normalizeIssueToolArgs } from './issue-args.js';

describe('normalizeIssueToolArgs', () => {
  it('clips an overlong title and maps kind aliases before create', () => {
    const title = `  ${'a'.repeat(400)}  `;
    const result = normalizeIssueToolArgs('create_issue', { title, kind: 'Inc', body: 'x'.repeat(20_050) });
    expect(result).toEqual({
      args: { title: 'a'.repeat(300), kind: 'incident', body: 'x'.repeat(20_000) },
    });
  });

  it('accepts the stored kinds and common spellings', () => {
    expect(normalizeIssueToolArgs('create_issue', { title: 'Login fails', kind: 'tech debt' })).toEqual({
      args: { title: 'Login fails', kind: 'tech_debt' },
    });
    expect(normalizeIssueToolArgs('update_issue', { idOrKey: 'BUG-1', kind: 'FEAT' })).toEqual({
      args: { idOrKey: 'BUG-1', kind: 'feature' },
    });
  });

  it('refuses a kind or title the issues API would reject, without calling it', () => {
    expect(normalizeIssueToolArgs('create_issue', { title: '   ', kind: 'bug' })).toEqual({
      error: 'title must be a string of 1 to 300 characters.',
    });
    expect(normalizeIssueToolArgs('create_issue', { title: { text: 'nope' }, kind: 'bug' })).toEqual({
      error: 'title must be a string of 1 to 300 characters.',
    });
    expect(normalizeIssueToolArgs('update_issue', { idOrKey: 'BUG-1', kind: 'task' })).toEqual({
      error: 'kind must be one of: bug, feature, incident, tech_debt, feedback, idea, security.',
    });
  });

  it('drops null title and kind on update and leaves other tools alone', () => {
    expect(normalizeIssueToolArgs('update_issue', { idOrKey: 'BUG-1', title: null, kind: null, estimate: 1001.2 })).toEqual({
      args: { idOrKey: 'BUG-1', estimate: 1000 },
    });
    const args = { title: 'x'.repeat(500), kind: 'nope' };
    expect(normalizeIssueToolArgs('create_workstream', args)).toEqual({ args });
  });
});
