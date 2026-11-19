// Test helpers shared by the statistics specs. Not imported by any component.
import type { Issue } from '../../core';
import type { TimeEntry } from '../../core/api/api.types';
import { DAY } from './stats-range';

export const NOW = Date.parse('2026-03-20T12:00:00Z');
export const HOUR = 3_600_000;
export const iso = (offsetDays: number): string => new Date(NOW + offsetDays * DAY).toISOString();

export function issue(id: string, patch: Partial<Issue> = {}): Issue {
  return {
    id,
    workspaceId: 'w',
    key: `T-${id}`,
    number: 1,
    kind: 'feature',
    title: `Task ${id}`,
    source: 'manual',
    priority: 'none',
    status: 'backlog',
    milestoneIds: [],
    labels: [],
    aliases: [],
    createdAt: iso(-60),
    updatedAt: iso(-60),
    ...patch,
  } as Issue;
}

/** A finished task: created `created` days ago, started `started` days ago, done `done` days ago. */
export function finished(id: string, created: number, started: number | undefined, done: number, patch: Partial<Issue> = {}): Issue {
  return issue(id, {
    status: 'done',
    createdAt: iso(-created),
    startedAt: started === undefined ? undefined : iso(-started),
    completedAt: iso(-done),
    updatedAt: iso(-done),
    ...patch,
  });
}

export function entry(issueId: string | null, startH: number, hours: number | null, userId = 'u1'): TimeEntry {
  const start = NOW - startH * HOUR;
  return {
    id: `e${Math.random()}`,
    workspaceId: 'w',
    userId,
    projectId: null,
    issueId,
    description: '',
    startedAt: new Date(start).toISOString(),
    endedAt: hours === null ? null : new Date(start + hours * HOUR).toISOString(),
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
  } as TimeEntry;
}
