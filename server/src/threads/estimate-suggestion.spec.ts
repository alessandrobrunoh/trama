import { describe, expect, it } from 'vitest';
import {
  buildEstimateSuggestion,
  median,
  rankSimilar,
  similarity,
  snapToScale,
  titleWords,
  type FinishedTask,
} from './estimate-suggestion.js';

const target = { title: 'Alerting when token refresh fails', projectId: 'pj_auth', labels: ['lb_backend'] };

let n = 0;
function done(over: Partial<FinishedTask> & { estimate: number }): FinishedTask {
  n++;
  return {
    id: `in_${n}`,
    key: `TRM-${n}`,
    title: 'Unrelated chore',
    projectId: null,
    labels: [],
    trackedMinutes: null,
    completedAt: new Date(2026, 0, n),
    ...over,
  };
}

describe('titleWords', () => {
  it('keeps lowercased words of three or more letters', () => {
    expect([...titleWords('Fix the OAuth refresh-token bug in UI')].sort()).toEqual([
      'bug',
      'fix',
      'oauth',
      'refresh',
      'the',
      'token',
    ]);
  });
});

describe('similarity', () => {
  it('ranks the same project over labels, and labels over title words', () => {
    const sameProject = similarity(target, { title: 'x', projectId: 'pj_auth', labels: [] });
    const labelled = similarity(target, { title: 'x', projectId: null, labels: ['lb_backend'] });
    const worded = similarity(target, { title: 'token refresh alerting', projectId: null, labels: [] });
    expect(sameProject).toBeGreaterThan(labelled);
    expect(labelled).toBeGreaterThan(worded);
    expect(worded).toBeGreaterThan(0);
  });

  it('is zero for tasks with nothing in common, and a missing project is not a shared project', () => {
    expect(similarity(target, { title: 'Unrelated chore', projectId: 'pj_other', labels: [] })).toBe(0);
    expect(
      similarity({ ...target, projectId: null }, { title: 'x', projectId: null, labels: [] }),
    ).toBe(0);
  });
});

describe('rankSimilar', () => {
  it('drops unrelated tasks, orders by score, then by the latest finish, and keeps five', () => {
    const tasks = [
      done({ estimate: 1 }),
      done({ estimate: 3, title: 'token refresh', projectId: null }),
      done({ estimate: 5, projectId: 'pj_auth' }),
      done({ estimate: 8, projectId: 'pj_auth', completedAt: new Date(2030, 0, 1) }),
      ...[2, 2, 2, 2].map((estimate) => done({ estimate, labels: ['lb_backend'] })),
    ];
    const ranked = rankSimilar(target, tasks);
    expect(ranked).toHaveLength(5);
    expect(ranked.map((task) => task.estimate).slice(0, 2)).toEqual([8, 5]);
    expect(ranked.some((task) => task.estimate === 1)).toBe(false);
  });
});

describe('median and snapToScale', () => {
  it('takes the middle value, or the mean of the two in the middle', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([3, 5])).toBe(4);
    expect(median([1, 2, 8, 13])).toBe(5);
  });

  it('snaps to the nearest value of the scale, upward when halfway', () => {
    const fib = [0, 1, 2, 3, 5, 8, 13, 21];
    expect(snapToScale(4, fib)).toBe(5);
    expect(snapToScale(6, fib)).toBe(5);
    expect(snapToScale(6.5, fib)).toBe(8);
    expect(snapToScale(100, fib)).toBe(21);
    expect(snapToScale(2.4, [1, 2, 4, 8])).toBe(2);
    expect(snapToScale(3, [1, 2, 4, 8])).toBe(4);
    expect(snapToScale(3, [])).toBeNull();
  });
});

describe('buildEstimateSuggestion', () => {
  it('suggests the median of the basis, snapped to the workspace scale', () => {
    const tasks = [
      done({ estimate: 3, projectId: 'pj_auth', trackedMinutes: 90 }),
      done({ estimate: 5, projectId: 'pj_auth' }),
      done({ estimate: 5, projectId: 'pj_auth' }),
      done({ estimate: 13, projectId: 'pj_auth' }),
    ];
    const result = buildEstimateSuggestion('in_target', target, tasks, 'fibonacci');
    expect(result.issueId).toBe('in_target');
    expect(result.suggestion).toBe(5);
    expect(result.scale).toEqual([0, 1, 2, 3, 5, 8, 13, 21]);
    expect(result.basis).toHaveLength(4);
    expect(result.basis.find((task) => task.estimate === 3)?.trackedMinutes).toBe(90);
    expect(result.reason).toContain('fibonacci');
  });

  it('snaps an in-between median to the scale of the workspace', () => {
    const tasks = [
      done({ estimate: 3, projectId: 'pj_auth' }),
      done({ estimate: 5, projectId: 'pj_auth' }),
    ];
    expect(buildEstimateSuggestion('in_t', target, tasks, 'fibonacci').suggestion).toBe(5);
    expect(buildEstimateSuggestion('in_t', target, tasks, 'linear').suggestion).toBe(4);
  });

  it('has no suggestion with fewer than two matches, and says why', () => {
    const none = buildEstimateSuggestion('in_t', target, [done({ estimate: 3 })], 'fibonacci');
    expect(none.suggestion).toBeNull();
    expect(none.basis).toEqual([]);
    expect(none.reason).toContain('0 similar');
    const one = buildEstimateSuggestion(
      'in_t',
      target,
      [done({ estimate: 3, projectId: 'pj_auth' })],
      'fibonacci',
    );
    expect(one.suggestion).toBeNull();
    expect(one.basis).toHaveLength(1);
    expect(one.reason).toContain('1 similar finished task ');
  });

  it('suggests nothing when estimates are turned off', () => {
    const tasks = [
      done({ estimate: 3, projectId: 'pj_auth' }),
      done({ estimate: 5, projectId: 'pj_auth' }),
    ];
    const result = buildEstimateSuggestion('in_t', target, tasks, 'none');
    expect(result.suggestion).toBeNull();
    expect(result.scale).toEqual([]);
  });
});
