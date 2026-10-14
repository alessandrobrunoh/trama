import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import {
  ArtifactEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  ProjectUpdateEntity,
} from '../database/entities/index.js';
import {
  assembleProjectContext,
  projectContextMarkdown,
  type ProjectContextRows,
} from './project-context.logic.js';
import { ProjectContextService } from './project-context.service.js';

const WS = 'ws_1';
const at = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const project = (o: Partial<ProjectEntity> = {}) =>
  Object.assign(new ProjectEntity(), {
    id: 'pj_1',
    workspaceId: WS,
    name: 'Billing',
    status: 'in_progress',
    priority: 'high',
    summary: null,
    description: null,
    leadId: null,
    startDate: null,
    targetDate: null,
    health: null,
    ...o,
  });
const issue = (n: number, o: Partial<IssueEntity> = {}) =>
  Object.assign(new IssueEntity(), {
    id: `in_${n}`,
    workspaceId: WS,
    key: `BUG-${n}`,
    number: n,
    kind: 'bug',
    title: `Issue ${n}`,
    status: 'todo',
    priority: 'none',
    projectId: 'pj_1',
    ...o,
  });
const artifact = (n: number, o: Partial<ArtifactEntity> = {}) =>
  Object.assign(new ArtifactEntity(), {
    id: `ar_${n}`,
    workspaceId: WS,
    kind: 'document',
    title: `Doc ${n}`,
    state: 'published',
    projectId: null,
    issueId: null,
    legacyWorkstreamKey: null,
    url: null,
    externalId: null,
    ci: null,
    review: null,
    hasConflicts: null,
    environment: null,
    description: null,
    createdAt: at(n),
    ...o,
  });
const decision = (n: number, o: Partial<DecisionEntity> = {}) =>
  Object.assign(new DecisionEntity(), {
    id: `dc_${n}`,
    workspaceId: WS,
    key: `ADR-${n}`,
    number: n,
    title: `Decision ${n}`,
    statement: 'Use X',
    status: 'accepted',
    originIssueId: null,
    relatedIssueIds: [],
    ...o,
  });
const input = (n: number, o: Partial<InputRequestEntity> = {}) =>
  Object.assign(new InputRequestEntity(), {
    id: `ir_${n}`,
    workspaceId: WS,
    issueId: 'in_1',
    question: `Question ${n}?`,
    options: null,
    state: 'open',
    createdAt: at(n),
    ...o,
  });
const rows = (o: Partial<ProjectContextRows> = {}): ProjectContextRows => ({
  project: project(),
  milestones: [],
  updates: [],
  issues: [],
  artifacts: [],
  decisions: [],
  inputRequests: [],
  ...o,
});
const pathOf = (ctx: ReturnType<typeof assembleProjectContext>, id: string) =>
  ctx.artifacts
    .find((a) => a.artifact.id === id)
    ?.path.map((s) => `${s.type}:${s.id}`);

describe('assembleProjectContext', () => {
  it('includes direct project issues and their artifacts, without legacy owners', () => {
    const ctx = assembleProjectContext(
      rows({
        issues: [issue(1), issue(2, { projectId: null })],
        artifacts: [
          artifact(1, { projectId: 'pj_1' }),
          artifact(2, { issueId: 'in_1' }),
          artifact(3, { issueId: 'in_2' }),
          artifact(4, { legacyWorkstreamKey: 'OLD-4' }),
        ],
      }),
    );
    expect(ctx.issues.map((i) => i.id)).toEqual(['in_1']);
    expect(pathOf(ctx, 'ar_1')).toEqual(['project:pj_1']);
    expect(pathOf(ctx, 'ar_2')).toEqual(['project:pj_1', 'issue:in_1']);
    expect(ctx.artifacts.map((a) => a.artifact.id)).toEqual(['ar_1', 'ar_2']);
  });

  it('includes only open input requests and decisions related to direct issues', () => {
    const ctx = assembleProjectContext(
      rows({
        issues: [issue(1)],
        decisions: [
          decision(1, { originIssueId: 'in_1' }),
          decision(2, { relatedIssueIds: ['in_1'] }),
          decision(3, { originIssueId: 'in_old' }),
        ],
        inputRequests: [
          input(1),
          input(2, { state: 'answered' }),
          input(3, { issueId: null }),
        ],
      }),
    );
    expect(ctx.decisions.map((d) => d.key)).toEqual(['ADR-1', 'ADR-2']);
    expect(ctx.inputRequests.map((r) => r.id)).toEqual(['ir_1']);
  });

  it('renders project-to-issue paths in markdown', () => {
    const ctx = assembleProjectContext(
      rows({
        issues: [issue(12)],
        artifacts: [artifact(1, { issueId: 'in_12', title: 'Design doc' })],
        decisions: [decision(1, { originIssueId: 'in_12' })],
        inputRequests: [input(1, { issueId: 'in_12', options: ['a', 'b'] })],
      }),
    );
    const md = projectContextMarkdown(ctx);
    expect(md).toContain('### Billing › BUG-12');
    expect(md).toContain('ADR-1 Decision 1: Use X (from BUG-12)');
    expect(md).toContain('BUG-12: Question 1? [options: a / b]');
    expect(md).not.toContain('Workstream');
  });
});

describe('ProjectContextService', () => {
  it('loads project-scoped issues and owned records from repositories', async () => {
    const entities = new Map<unknown, readonly unknown[]>([
      [MilestoneEntity, []],
      [IssueEntity, [issue(1)]],
      [ArtifactEntity, [artifact(1, { issueId: 'in_1' })]],
      [DecisionEntity, [decision(1, { originIssueId: 'in_1' })]],
      [InputRequestEntity, [input(1)]],
      [ProjectUpdateEntity, []],
    ]);
    const ds = {
      getRepository: (entity: unknown) => ({
        findOneBy: async () => (entity === ProjectEntity ? project() : null),
        find: async () => entities.get(entity) ?? [],
      }),
    } as unknown as DataSource;
    const ctx = await new ProjectContextService(ds).build(WS, 'pj_1');
    expect(ctx.issues.map((i) => i.id)).toEqual(['in_1']);
    expect(ctx.artifacts.map((a) => a.artifact.id)).toEqual(['ar_1']);
    expect(ctx.decisions.map((d) => d.id)).toEqual(['dc_1']);
    expect(ctx.inputRequests.map((r) => r.id)).toEqual(['ir_1']);
  });

  it('404s for an unknown project', async () => {
    const ds = {
      getRepository: () => ({
        findOneBy: async () => null,
        find: async () => [],
      }),
    } as unknown as DataSource;
    await expect(
      new ProjectContextService(ds).build(WS, 'pj_nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
