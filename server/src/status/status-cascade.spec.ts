import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  ArtifactEntity,
  DecisionEntity,
  DependencyEntity,
  InputRequestEntity,
  IssueEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { StatusService } from './status.service.js';

type Row = Record<string, any>;

const mk = (id: string, status: string): Row => ({
  id,
  key: id,
  title: id,
  workspaceId: 'w',
  status,
  derivedStatus: status,
  delivery: 'none',
  statusOverride: null,
  shippedAt: null,
  acceptanceCriteria: [{ id: 'c', text: 't', state: 'met' }],
});

/** In-memory DataSource: every workstream has a merged PR and met criteria. */
function setup(ids: string[], edges: [string, string][], initial: string) {
  const ws: Record<string, Row> = Object.fromEntries(ids.map((id) => [id, mk(id, initial)]));
  const arts = ids.map((id) => ({ id: 'pr' + id, workstreamId: id, kind: 'pull_request', state: 'merged' }));
  const deps = edges.map(([fromId, toId]) => ({ fromId, toId, workspaceId: 'w', fromType: 'workstream', toType: 'workstream' }));
  const repo = (e: unknown) => {
    if (e === WorkstreamEntity)
      return {
        findOneBy: async ({ id }: Row) => ws[id] && { ...ws[id] },
        find: async ({ where }: Row) => Object.values(ws).filter((w) => (where.id?._value ?? []).includes(w.id)),
        update: async ({ id }: Row, patch: Row) => Object.assign(ws[id], patch),
      };
    if (e === ArtifactEntity) return { find: async ({ where }: Row) => arts.filter((a) => a.workstreamId === where.workstreamId) };
    if (e === DependencyEntity)
      return { find: async ({ where }: Row) => deps.filter((d) => (where.toId ? d.toId === where.toId : d.fromId === where.fromId)) };
    if (e === InputRequestEntity || e === DecisionEntity) return { find: async () => [] };
    if (e === IssueEntity) {
      return {
        createQueryBuilder: () => {
          const q: Row = { select: () => q, where: () => q, andWhere: () => q, getMany: async () => [] };
          return q;
        },
      };
    }
    throw new Error('unexpected ' + String(e));
  };
  const events = { record: async () => undefined, publish: () => undefined };
  const svc = new StatusService({ getRepository: repo } as never, events as never, {} as never);
  return { ws, svc };
}

describe('status cascade over dependencies', () => {
  it('re-derives a node reached through two paths once both sources have settled (diamond)', async () => {
    const { ws, svc } = setup(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']], 'blocked');
    ws['A'].status = ws['A'].derivedStatus = 'working';
    await svc.recompute('A', [], new Set(), true);
    expect(ws['A'].status).toBe('shipped');
    expect(ws['B'].status).toBe('shipped');
    expect(ws['C'].status).toBe('shipped');
    expect(ws['D'].status).toBe('shipped');
  });

  it('terminates on a dependency cycle', async () => {
    const { ws, svc } = setup(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['C', 'A']], 'working');
    await svc.recompute('A', [], new Set(), true);
    expect(Object.keys(ws)).toHaveLength(3);
  });
});
