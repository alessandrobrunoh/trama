import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  ProjectUpdateEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { assembleProjectContext, CONTEXT_CAPS, projectContextMarkdown, type ProjectContextRows } from './project-context.logic.js';
import { ProjectContextService } from './project-context.service.js';

const WS = 'ws_1';
const at = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

const project = (o: Partial<ProjectEntity> = {}) =>
  Object.assign(new ProjectEntity(), { id: 'pj_1', workspaceId: WS, name: 'Billing', status: 'in_progress', priority: 'high', summary: null, description: null, leadId: null, startDate: null, targetDate: null, health: null, ...o });
const workstream = (n: number, o: Partial<WorkstreamEntity> = {}) =>
  Object.assign(new WorkstreamEntity(), { id: `wk_${n}`, workspaceId: WS, key: `WS-${n}`, number: n, title: `Stream ${n}`, objective: '', status: 'working', projectId: 'pj_1', targetDate: null, ...o });
const issue = (n: number, o: Partial<IssueEntity> = {}) =>
  Object.assign(new IssueEntity(), { id: `in_${n}`, workspaceId: WS, key: `BUG-${n}`, number: n, kind: 'bug', title: `Issue ${n}`, status: 'todo', priority: 'none', projectId: null, workstreamIds: [], milestoneIds: [], ...o });
const artifact = (n: number, o: Partial<ArtifactEntity> = {}) =>
  Object.assign(new ArtifactEntity(), { id: `ar_${n}`, workspaceId: WS, kind: 'document', title: `Doc ${n}`, state: 'published', workstreamId: null, projectId: null, issueId: null, url: null, externalId: null, ci: null, review: null, hasConflicts: null, environment: null, description: null, createdAt: at(n), ...o });
const decision = (n: number, o: Partial<DecisionEntity> = {}) =>
  Object.assign(new DecisionEntity(), { id: `dc_${n}`, workspaceId: WS, key: `ADR-${n}`, number: n, title: `Decision ${n}`, statement: 'Use X', status: 'accepted', originWorkstreamId: null, ...o });
const input = (n: number, o: Partial<InputRequestEntity> = {}) =>
  Object.assign(new InputRequestEntity(), { id: `ir_${n}`, workspaceId: WS, workstreamId: 'wk_1', question: `Question ${n}?`, options: null, state: 'open', createdAt: at(n), ...o });

function rows(o: Partial<ProjectContextRows> = {}): ProjectContextRows {
  return { project: project(), milestones: [], updates: [], workstreams: [], issues: [], artifacts: [], decisions: [], inputRequests: [], ...o };
}

const pathOf = (r: ReturnType<typeof assembleProjectContext>, id: string) => r.artifacts.find((a) => a.artifact.id === id)?.path.map((s) => `${s.type}:${s.id}`);

describe('assembleProjectContext', () => {
  it('builds the tree project > workstream > issue > artifact with the chain to each owner', () => {
    const ctx = assembleProjectContext(
      rows({
        workstreams: [workstream(1), workstream(2, { projectId: 'pj_other' })],
        issues: [issue(1, { workstreamIds: ['wk_1'] }), issue(2, { workstreamIds: ['wk_2'] })],
        artifacts: [
          artifact(1, { projectId: 'pj_1' }),
          artifact(2, { workstreamId: 'wk_1' }),
          artifact(3, { issueId: 'in_1' }),
          artifact(4, { workstreamId: 'wk_2' }),
          artifact(5, { issueId: 'in_2' }),
        ],
      }),
    );
    expect(ctx.workstreams.map((w) => w.id)).toEqual(['wk_1']);
    expect(ctx.issues.map((i) => i.id)).toEqual(['in_1']);
    expect(pathOf(ctx, 'ar_1')).toEqual(['project:pj_1']);
    expect(pathOf(ctx, 'ar_2')).toEqual(['project:pj_1', 'workstream:wk_1']);
    expect(pathOf(ctx, 'ar_3')).toEqual(['project:pj_1', 'workstream:wk_1', 'issue:in_1']);
    expect(ctx.artifacts.map((a) => a.artifact.id)).toEqual(['ar_1', 'ar_2', 'ar_3']);
  });

  it('reaches an artifact attached only to an issue planned directly under the project', () => {
    const ctx = assembleProjectContext(
      rows({ issues: [issue(7, { projectId: 'pj_1' })], artifacts: [artifact(1, { issueId: 'in_7' })] }),
    );
    expect(ctx.issues.map((i) => i.key)).toEqual(['BUG-7']);
    expect(pathOf(ctx, 'ar_1')).toEqual(['project:pj_1', 'issue:in_7']);
  });

  it('lists an artifact with several owners once, under its highest owner', () => {
    const ctx = assembleProjectContext(
      rows({
        workstreams: [workstream(1)],
        issues: [issue(1, { workstreamIds: ['wk_1'], projectId: 'pj_1' })],
        artifacts: [
          artifact(1, { projectId: 'pj_1', workstreamId: 'wk_1', issueId: 'in_1' }),
          artifact(2, { workstreamId: 'wk_1', issueId: 'in_1' }),
          artifact(3, { issueId: 'in_1' }),
        ],
      }),
    );
    expect(ctx.artifacts).toHaveLength(3);
    expect(pathOf(ctx, 'ar_1')).toEqual(['project:pj_1']);
    expect(pathOf(ctx, 'ar_2')).toEqual(['project:pj_1', 'workstream:wk_1']);
    // issue planned under the project AND in a workstream: the shorter chain wins
    expect(pathOf(ctx, 'ar_3')).toEqual(['project:pj_1', 'issue:in_1']);
  });

  it('dedups artifacts fetched more than once and ignores owners outside the project', () => {
    const a = artifact(1, { workstreamId: 'wk_1' });
    const ctx = assembleProjectContext(
      rows({
        workstreams: [workstream(1)],
        issues: [issue(9, { workstreamIds: ['wk_unknown'] })],
        artifacts: [a, a, artifact(2, { projectId: 'pj_other' }), artifact(3, { issueId: 'in_9' })],
      }),
    );
    expect(ctx.artifacts.map((r) => r.artifact.id)).toEqual(['ar_1']);
    expect(ctx.issues).toEqual([]);
  });

  it('keeps decisions originating in the project workstreams and only open input requests of them', () => {
    const ctx = assembleProjectContext(
      rows({
        workstreams: [workstream(1)],
        decisions: [decision(1, { originWorkstreamId: 'wk_1' }), decision(2, { originWorkstreamId: 'wk_9' }), decision(3)],
        inputRequests: [input(1), input(2, { state: 'answered' }), input(3, { workstreamId: 'wk_9' })],
      }),
    );
    expect(ctx.decisions.map((d) => d.key)).toEqual(['ADR-1']);
    expect(ctx.inputRequests.map((r) => r.id)).toEqual(['ir_1']);
  });
});

describe('projectContextMarkdown', () => {
  it('groups artifacts by the chain to their owner', () => {
    const ctx = assembleProjectContext(
      rows({
        workstreams: [workstream(1)],
        issues: [issue(12, { workstreamIds: ['wk_1'] })],
        artifacts: [artifact(1, { issueId: 'in_12', title: 'Design doc', url: 'https://x.test/d' }), artifact(2, { projectId: 'pj_1', title: 'Brief' })],
        decisions: [decision(1, { originWorkstreamId: 'wk_1' })],
        inputRequests: [input(1, { options: ['a', 'b'] })],
      }),
    );
    const md = projectContextMarkdown(ctx);
    expect(md).toContain('# Project — Billing');
    expect(md).toContain('### Billing › WS-1 › BUG-12');
    expect(md).toContain('### Billing\n');
    expect(md).toContain('Design doc — https://x.test/d');
    expect(md).toContain('ADR-1 Decision 1: Use X (from WS-1)');
    expect(md).toContain('WS-1: Question 1? [options: a / b]');
  });

  it('caps long sections with a "more" line', () => {
    const many = CONTEXT_CAPS.issues + 5;
    const ctx = assembleProjectContext(rows({ issues: Array.from({ length: many }, (_, i) => issue(i + 1, { projectId: 'pj_1' })) }));
    const md = projectContextMarkdown(ctx);
    expect(md).toContain('- … 5 more');
    expect(md).not.toContain(`BUG-${many} `);
  });
});

describe('ProjectContextService', () => {
  /** Ignores `where`s: the assembler re-filters, which is exactly what the fake exercises. */
  function setup(data: Partial<ProjectContextRows> & { updatesFail?: boolean; linkedIssueIds?: string[] } = {}) {
    const byEntity = new Map<unknown, readonly unknown[]>([
      [MilestoneEntity, data.milestones ?? []],
      [WorkstreamEntity, data.workstreams ?? []],
      [IssueEntity, data.issues ?? []],
      [ArtifactEntity, data.artifacts ?? []],
      [DecisionEntity, data.decisions ?? []],
      [InputRequestEntity, data.inputRequests ?? []],
      [ProjectUpdateEntity, data.updates ?? []],
    ]);
    const query = vi.fn(async () => (data.linkedIssueIds ?? []).map((id) => ({ id })));
    const ds = {
      getRepository: (e: unknown) => ({
        findOneBy: async () => (e === ProjectEntity ? (data.project ?? project()) : null),
        find: async () => {
          if (e === ProjectUpdateEntity && data.updatesFail) throw new Error('relation "project_updates" does not exist');
          return byEntity.get(e) ?? [];
        },
      }),
      query,
    } as unknown as DataSource;
    return { service: new ProjectContextService(ds), query };
  }

  it('builds the context through the repositories', async () => {
    const { service, query } = setup({
      workstreams: [workstream(1)],
      issues: [issue(1, { workstreamIds: ['wk_1'] })],
      artifacts: [artifact(1, { issueId: 'in_1' })],
      linkedIssueIds: ['in_1'],
    });
    const ctx = await service.build(WS, 'pj_1');
    expect(query).toHaveBeenCalledOnce();
    expect(ctx.artifacts).toHaveLength(1);
    expect(ctx.artifacts[0].path.map((s) => s.type)).toEqual(['project', 'workstream', 'issue']);
  });

  it('returns no updates instead of failing when the updates cannot be read', async () => {
    const { service } = setup({ updatesFail: true, workstreams: [workstream(1)] });
    const ctx = await service.build(WS, 'pj_1');
    expect(ctx.updates).toEqual([]);
    expect(ctx.workstreams).toHaveLength(1);
  });

  it('404s for an unknown project', async () => {
    const ds = { getRepository: () => ({ findOneBy: async () => null, find: async () => [] }), query: async () => [] } as unknown as DataSource;
    await expect(new ProjectContextService(ds).build(WS, 'pj_nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renders the markdown briefing', async () => {
    const { service } = setup({ workstreams: [workstream(1)] });
    expect(await service.markdown(WS, 'pj_1')).toContain('WS-1 Stream 1');
  });
});
