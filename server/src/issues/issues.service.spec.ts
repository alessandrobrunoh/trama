import { describe, expect, it, vi } from 'vitest';
import type { IssueStatus } from '../contracts/domain.js';
import { IssuesService } from './issues.service.js';

const actor = { type: 'user' as const, id: 'usr_me' };

function makeService(status: IssueStatus) {
  const row = {
    id: 'iss_1',
    key: 'BUG-1',
    status,
    assigneeId: null as string | null,
    duplicateOfId: null,
    workstreamIds: [] as string[],
    startedAt: null as Date | null,
    completedAt: null as Date | null,
    updatedAt: new Date(0),
  };
  const save = vi.fn(async (r: unknown) => r);
  const record = vi.fn(async () => undefined);
  const ds = { transaction: async (fn: (m: unknown) => Promise<void>) => fn({ save }) };
  const refs = { workstreams: vi.fn(async () => undefined), users: vi.fn(async () => undefined) };
  const bus = { touchMany: vi.fn(async () => undefined) };
  const repo = { findOneBy: vi.fn(async () => row) };
  const service = new IssuesService(
    ds as never,
    refs as never,
    {} as never,
    { record } as never,
    bus as never,
    {} as never,
    {} as never,
    repo as never,
  );
  return { service, row, record };
}

describe('IssuesService.link', () => {
  it.each<IssueStatus>(['draft', 'backlog', 'todo'])(
    'keeps a %s issue in its status when linking',
    async (status) => {
      const { service, row, record } = makeService(status);
      const res = await service.link('ws_1', actor, 'iss_1', { workstreamIds: ['wk_1'] });
      expect(res.status).toBe(status);
      expect(res.workstreamIds).toEqual(['wk_1']);
      expect(res.startedAt).toBeNull();
      expect(res.assigneeId).toBeNull();
      expect(row.status).toBe(status);
      const types = record.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type);
      expect(types).toContain('issue.linked');
      expect(types).not.toContain('issue.status_changed');
    },
  );

  it('still applies an explicit status', async () => {
    const { service, record } = makeService('todo');
    const res = await service.link('ws_1', actor, 'iss_1', {
      workstreamIds: ['wk_1'],
      status: 'in_progress',
    });
    expect(res.status).toBe('in_progress');
    expect(res.startedAt).toBeInstanceOf(Date);
    expect(res.assigneeId).toBe('usr_me');
    const types = record.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type);
    expect(types).toContain('issue.status_changed');
  });
});
