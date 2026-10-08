import { createSeed } from './seed-data.js';

describe('demo seed', () => {
  const data = createSeed(Date.parse('2026-10-07T12:00:00Z'), 'hash');

  it('covers every derived workstream status', () => {
    const statuses = new Set(data.workstreams.map((w) => w.status));
    for (const s of ['draft', 'planned', 'working', 'needs_input', 'in_review', 'blocked', 'ready_to_land', 'shipped', 'canceled'])
      expect(statuses).toContain(s);
    expect(data.workstreams.map((w) => w.key)).toEqual(expect.arrayContaining(['AUTH-42', 'WEB-81', 'INF-31']));
  });

  it('has realistic volume and unique keys', () => {
    expect(data.events!.length).toBeGreaterThanOrEqual(180);
    expect(data.decisions.length).toBeGreaterThanOrEqual(20);
    expect(data.issues.length).toBeGreaterThanOrEqual(15);
    for (const rows of [data.workstreams, data.issues, data.decisions]) {
      const keys = rows.map((r) => (r as { key: string }).key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(data.counters['adr']).toBeGreaterThanOrEqual(21);
  });

  it('has consistent references', () => {
    const ids = new Set<string>();
    for (const rows of [data.workstreams, data.artifacts, data.decisions, data.teams, data.repositories, data.users, data.agents, data.issues, data.inputRequests])
      for (const r of rows) ids.add((r as { id: string }).id);
    for (const w of data.workstreams) expect(String(w.deltaThreadUrl)).toMatch(/^https:\/\/([a-z0-9-]+\.)*delta\.dev\//);
    for (const d of data.dependencies) {
      expect(ids.has(d.fromId!)).toBe(true);
      expect(ids.has(d.toId!)).toBe(true);
    }
    for (const d of data.decisions) if (d.supersededById) expect(ids.has(d.supersededById)).toBe(true);
    for (const i of data.issues) for (const w of i.workstreamIds ?? []) expect(ids.has(w)).toBe(true);
    for (const w of data.workstreams) expect(ids.has(w.ownerTeamId!)).toBe(true);
  });

  it('never lies in the future', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    for (const e of data.events) expect((e.at as Date).getTime()).toBeLessThanOrEqual(now);
  });
});
