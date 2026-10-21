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
import { memberAccessStore } from '../auth/member-access.js';
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

  it('renders database totals for associations beyond the capped issue window', () => {
    const issues = Array.from({ length: 45 }, (_, i) =>
      issue(i + 1, { status: i < 40 ? 'done' : 'todo' }),
    );
    const decisions = Array.from({ length: 22 }, (_, i) =>
      decision(i + 1, { originIssueId: `in_${i + 41}` }),
    );
    const inputRequests = Array.from({ length: 22 }, (_, i) =>
      input(i + 1, { issueId: `in_${i + 41}` }),
    );
    const ctx = assembleProjectContext(
      rows({
        issues: issues.slice(0, 40),
        decisions,
        inputRequests,
        includeUnmatchedAssociations: true,
      }),
    );
    const md = projectContextMarkdown(ctx, {
      counts: { issues: 45, openIssues: 5, decisions: 22, inputRequests: 22 },
    });

    expect(ctx.issues).toHaveLength(40);
    expect(ctx.decisions).toHaveLength(22);
    expect(ctx.inputRequests).toHaveLength(22);
    expect(md).toContain('_40 more issues are done or canceled._');
    expect(md).toContain('- … 2 more');
  });

  it('caps rendered markdown sections but preserves the full JSON context', () => {
    const allIssues = Array.from({ length: 45 }, (_, i) => issue(i + 1));
    const ctx = assembleProjectContext(rows({ issues: allIssues }));
    const md = projectContextMarkdown(ctx);

    expect(ctx.issues).toHaveLength(45);
    expect(md.match(/^- BUG-/gm)).toHaveLength(40);
    expect(md).toContain('- … 5 more');
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

  it('hides parent ids for Issues whose parent is outside project access', async () => {
    const child = issue(1, { projectId: 'pj_1', parentId: 'in_2' });
    const hiddenParent = issue(2, { projectId: 'pj_2' });
    const entities = new Map<unknown, readonly unknown[]>([
      [MilestoneEntity, []],
      [ArtifactEntity, []],
      [DecisionEntity, []],
      [InputRequestEntity, []],
      [ProjectUpdateEntity, []],
    ]);
    const ds = {
      getRepository: (entity: unknown) => ({
        findOneBy: async () => (entity === ProjectEntity ? project() : null),
        find: async (options?: { select?: unknown }) =>
          entity === IssueEntity
            ? options?.select
              ? [hiddenParent]
              : [child]
            : (entities.get(entity) ?? []),
      }),
    } as unknown as DataSource;
    const access = {
      projects: { all: false, projectIds: ['pj_1'] },
      includeUnassigned: false,
      grants: [],
    };

    const ctx = await memberAccessStore.run(access, () =>
      new ProjectContextService(ds).build(WS, 'pj_1'),
    );

    expect(ctx.issues[0].parentId).toBeNull();
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

  it('does not fetch markdown rows for a project hidden by authorization', async () => {
    const ds = {
      getRepository: (entity: unknown) => ({
        findOneBy: async () => (entity === ProjectEntity ? project() : null),
        find: async () => [],
      }),
    } as unknown as DataSource;
    const access = {
      projects: { all: false, projectIds: [] },
      includeUnassigned: false,
      grants: [],
    };

    await expect(
      memberAccessStore.run(access, () =>
        new ProjectContextService(ds).markdown(WS, 'pj_1'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
