import { describe, expect, it } from 'vitest';
import { ActivityLog, describeTool } from './activity.js';

describe('describeTool', () => {
  it('turns tool names into short past-tense labels', () => {
    expect(describeTool('list_issues')).toBe('Looked at issues');
    expect(describeTool('get_issue')).toBe('Looked at issue');
    expect(describeTool('create_issue')).toBe('Created issue');
    expect(describeTool('update_workstream')).toBe('Updated workstream');
    expect(describeTool('answer_input_request')).toBe('Answered input request');
    expect(describeTool('delete_view')).toBe('Deleted view');
    expect(describeTool('search')).toBe('Searched the workspace');
    expect(describeTool('whoami')).toBe('Checked its permissions');
    expect(describeTool('mystery_thing')).toBe('Used thing');
  });
});

describe('ActivityLog', () => {
  it('merges consecutive identical steps and keeps notes in order', () => {
    const log = new ActivityLog();
    log.note('  Checking your issues  ');
    log.note('x'.repeat(400)); // thinking out loud: dropped
    log.tool('list_issues', false);
    log.tool('list_issues', false);
    log.tool('list_teams', false, false, 'HTTP 403: nope');
    log.tool('create_issue', true, true);
    log.tool('create_issue', true, false, "HTTP 400:\n kind must be one of bug|feature");
    const a = log.result()!;
    expect(a.steps).toEqual([
      { kind: 'note', label: 'Checking your issues' },
      { kind: 'read', label: 'Looked at issues', count: 2 },
      { kind: 'read', label: 'Looked at teams', ok: false, detail: 'HTTP 403: nope' },
      { kind: 'write', label: 'Created issue', ok: true },
      { kind: 'write', label: 'Created issue', ok: false, detail: 'HTTP 400: kind must be one of bug|feature' },
    ]);
    expect(a.seconds).toBeGreaterThanOrEqual(1);
  });

  it('reports nothing when no tool ran', () => {
    const log = new ActivityLog();
    log.note('just thinking');
    expect(log.result()).toBeUndefined();
  });
});
