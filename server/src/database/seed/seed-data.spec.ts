import { createSeed } from './seed-data.js';

describe('demo seed', () => {
  const data = createSeed(Date.parse('2026-10-07T12:00:00Z'), 'hash');

  it('retains legacy provenance without active Workstream or Issue links', () => {
    expect(data.legacyWorkstreams.map((row) => row.key)).toEqual(
      expect.arrayContaining(['AUTH-42', 'WEB-81', 'INF-31']),
    );
    expect(data.issues.every((issue) => !Object.hasOwn(issue, 'workstreamIds'))).toBe(true);
    expect(data.issues.find((issue) => issue.key === 'SEC-6')?.goal).toBeTruthy();
    expect(data.issues.find((issue) => issue.key === 'BUG-142')?.goal).toBeNull();
  });

  it('has realistic volume and unique keys', () => {
    expect(data.events!.length).toBeGreaterThanOrEqual(180);
    expect(data.decisions.length).toBeGreaterThanOrEqual(20);
    expect(data.issues.length).toBeGreaterThanOrEqual(15);
    for (const rows of [data.legacyWorkstreams, data.issues, data.decisions]) {
      const keys = rows.map((r) => (r as { key: string }).key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(data.counters['adr']).toBeGreaterThanOrEqual(21);
  });

  it('has consistent references', () => {
    const ids = new Set<string>();
    for (const rows of [data.legacyWorkstreams, data.artifacts, data.decisions, data.teams, data.repositories, data.users, data.agents, data.issues, data.inputRequests])
      for (const r of rows) ids.add((r as { id: string }).id);
    for (const d of data.dependencies) {
      expect(ids.has(d.fromId!)).toBe(true);
      expect(ids.has(d.toId!)).toBe(true);
    }
    for (const d of data.decisions) if (d.supersededById) expect(ids.has(d.supersededById)).toBe(true);
  });

  it('never lies in the future', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    for (const e of data.events) expect((e.at as Date).getTime()).toBeLessThanOrEqual(now);
  });

  it('includes deterministic mock estimate history', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const done = data.issues.filter((i) => i.status === 'done' && i.estimate != null && i.startedAt && i.completedAt);
    expect(done.length).toBeGreaterThanOrEqual(35);
    for (const i of data.issues) {
      if (i.startedAt && i.completedAt) expect(i.startedAt.getTime()).toBeLessThanOrEqual(i.completedAt.getTime());
      expect(i.createdAt!.getTime()).toBeLessThanOrEqual(now);
    }
    const mockIds = new Set(data.issues.filter((i) => i.id!.startsWith('in_mock_')).map((i) => i.id));
    expect(mockIds.size).toBeGreaterThanOrEqual(40);
    expect(data.events.some((e) => e.type === 'issue.linked' && mockIds.has(e.subject!.id))).toBe(false);
    const again = createSeed(now, 'hash');
    const shape = (d: typeof data) => d.issues.filter((i) => i.id!.startsWith('in_mock_')).map((i) => [i.key, i.estimate, i.completedAt?.getTime()]);
    expect(shape(again)).toEqual(shape(data));
    expect(createSeed(now, 'hash', { mockHistory: false }).issues.some((i) => i.id!.startsWith('in_mock_'))).toBe(false);
  });
});
