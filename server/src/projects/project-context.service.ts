import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { notFound } from '../common/util.js';
import { currentAccess, projectHidden } from '../auth/member-access.js';
import {
  AgentEntity,
  ArtifactEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  ProjectUpdateEntity,
  UserEntity,
} from '../database/entities/index.js';
import {
  assembleProjectContext,
  CONTEXT_CAPS,
  projectContextMarkdown,
  type ProjectContextData,
} from './project-context.logic.js';

/** Project updates shipped with the context (newest first). */
const UPDATES_LIMIT = 20;

/**
 * Project context contains direct Issues and their owned records, plus project-owned records.
 */
@Injectable()
export class ProjectContextService {
  private readonly logger = new Logger(ProjectContextService.name);

  constructor(private readonly ds: DataSource) {}

  async build(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectContextData> {
    const repo = <T extends object>(e: new () => T) => this.ds.getRepository(e);
    const project = await repo(ProjectEntity).findOneBy({
      workspaceId,
      id: projectId,
    });
    if (!project || projectHidden(currentAccess(), project.id))
      throw notFound('Project', projectId);

    const [milestones, updates] = await Promise.all([
      repo(MilestoneEntity).find({
        where: { workspaceId, projectId },
        order: { sortOrder: 'ASC' },
      }),
      this.updates(workspaceId, projectId),
    ]);
    const issues = await repo(IssueEntity).find({
      where: { workspaceId, projectId },
      order: { number: 'ASC' },
    });
    const parentIds = [
      ...new Set(
        issues.flatMap((issue) => (issue.parentId ? [issue.parentId] : [])),
      ),
    ];
    if (parentIds.length) {
      const parents = await repo(IssueEntity).find({
        where: { workspaceId, id: In(parentIds) },
        select: { id: true, projectId: true },
      });
      const visibleParentIds = new Set(
        parents
          .filter((parent) => !projectHidden(currentAccess(), parent.projectId))
          .map((parent) => parent.id),
      );
      for (const issue of issues)
        if (issue.parentId && !visibleParentIds.has(issue.parentId))
          issue.parentId = null;
    }
    const issueIds = issues.map((i) => i.id);

    const [artifacts, decisions, inputRequests] = await Promise.all([
      repo(ArtifactEntity).find({
        where: [
          { workspaceId, projectId },
          ...(issueIds.length ? [{ workspaceId, issueId: In(issueIds) }] : []),
        ],
        order: { createdAt: 'ASC' },
      }),
      issueIds.length
        ? repo(DecisionEntity).find({
            where: { workspaceId, originIssueId: In(issueIds) },
            order: { number: 'ASC' },
          })
        : [],
      issueIds.length
        ? repo(InputRequestEntity).find({
            where: { workspaceId, issueId: In(issueIds), state: 'open' },
            order: { createdAt: 'ASC' },
          })
        : [],
    ]);

    return assembleProjectContext({
      project,
      milestones,
      updates,
      issues,
      artifacts,
      decisions,
      inputRequests,
    });
  }

  /** Bounded Markdown briefing; JSON context remains the complete representation. */
  async markdown(workspaceId: string, projectId: string): Promise<string> {
    const repo = <T extends object>(e: new () => T) => this.ds.getRepository(e);
    const project = await repo(ProjectEntity).findOneBy({
      workspaceId,
      id: projectId,
    });
    if (!project || projectHidden(currentAccess(), project.id))
      throw notFound('Project', projectId);

    const [milestones, updates] = await Promise.all([
      repo(MilestoneEntity).find({
        where: { workspaceId, projectId },
        order: { sortOrder: 'ASC', id: 'ASC' },
        take: CONTEXT_CAPS.milestones,
      }),
      this.updates(workspaceId, projectId),
    ]);
    const issueRepo = repo(IssueEntity);
    const [issues, issueCount, openIssueCount] = await Promise.all([
      issueRepo.find({
        where: { workspaceId, projectId },
        order: { number: 'ASC', id: 'ASC' },
        take: CONTEXT_CAPS.issues,
      }),
      issueRepo.countBy({ workspaceId, projectId }),
      issueRepo
        .createQueryBuilder('i')
        .where('i.workspaceId = :workspaceId', { workspaceId })
        .andWhere('i.projectId = :projectId', { projectId })
        .andWhere("i.status NOT IN ('done', 'canceled')")
        .getCount(),
    ]);
    const issueTargetQuery = () =>
      this.ds
        .getRepository(IssueEntity)
        .createQueryBuilder('i')
        .select('i.id')
        .where('i.workspaceId = :workspaceId', { workspaceId })
        .andWhere('i.projectId = :projectId', { projectId });
    const artifactRepo = repo(ArtifactEntity);
    const [
      artifacts,
      artifactCount,
      decisions,
      decisionCount,
      inputRequests,
      inputRequestCount,
    ] = await Promise.all([
      artifactRepo
        .createQueryBuilder('a')
        .where('a.workspaceId = :workspaceId', { workspaceId })
        .andWhere(
          '(a.projectId = :projectId OR a.issueId IN (' +
            issueTargetQuery().getQuery() +
            '))',
          { projectId },
        )
        .setParameters(issueTargetQuery().getParameters())
        .orderBy('a.createdAt', 'ASC')
        .addOrderBy('a.id', 'ASC')
        .take(CONTEXT_CAPS.artifacts)
        .getMany(),
      artifactRepo
        .createQueryBuilder('a')
        .where('a.workspaceId = :workspaceId', { workspaceId })
        .andWhere(
          '(a.projectId = :projectId OR a.issueId IN (' +
            issueTargetQuery().getQuery() +
            '))',
          { projectId },
        )
        .setParameters(issueTargetQuery().getParameters())
        .getCount(),
      repo(DecisionEntity)
        .createQueryBuilder('d')
        .where('d.workspaceId = :workspaceId', { workspaceId })
        .andWhere("d.status NOT IN ('rejected', 'draft')")
        .andWhere(
          '(d."originIssueId" IN (' +
            issueTargetQuery().getQuery() +
            ') OR d."relatedIssueIds" ?| ARRAY(SELECT "id" FROM "issues" WHERE "workspaceId" = :workspaceId AND "projectId" = :projectId))',
          { projectId },
        )
        .setParameters(issueTargetQuery().getParameters())
        .orderBy('d.number', 'ASC')
        .addOrderBy('d.id', 'ASC')
        .take(CONTEXT_CAPS.decisions)
        .getMany(),
      repo(DecisionEntity)
        .createQueryBuilder('d')
        .where('d.workspaceId = :workspaceId', { workspaceId })
        .andWhere("d.status NOT IN ('rejected', 'draft')")
        .andWhere(
          '(d."originIssueId" IN (' +
            issueTargetQuery().getQuery() +
            ') OR d."relatedIssueIds" ?| ARRAY(SELECT "id" FROM "issues" WHERE "workspaceId" = :workspaceId AND "projectId" = :projectId))',
          { projectId },
        )
        .setParameters(issueTargetQuery().getParameters())
        .getCount(),
      repo(InputRequestEntity)
        .createQueryBuilder('r')
        .where('r.workspaceId = :workspaceId', { workspaceId })
        .andWhere('r.state = :state', { state: 'open' })
        .andWhere('r.issueId IN (' + issueTargetQuery().getQuery() + ')')
        .setParameters(issueTargetQuery().getParameters())
        .orderBy('r.createdAt', 'ASC')
        .addOrderBy('r.id', 'ASC')
        .take(CONTEXT_CAPS.inputRequests)
        .getMany(),
      repo(InputRequestEntity)
        .createQueryBuilder('r')
        .where('r.workspaceId = :workspaceId', { workspaceId })
        .andWhere('r.state = :state', { state: 'open' })
        .andWhere('r.issueId IN (' + issueTargetQuery().getQuery() + ')')
        .setParameters(issueTargetQuery().getParameters())
        .getCount(),
    ]);
    const ctx = assembleProjectContext({
      project,
      milestones,
      updates,
      issues,
      artifacts,
      decisions,
      inputRequests,
      includeUnmatchedAssociations: true,
    });
    return projectContextMarkdown(ctx, {
      names: await this.names(ctx),
      counts: {
        issues: issueCount,
        openIssues: openIssueCount,
        artifacts: artifactCount,
        decisions: decisionCount,
        inputRequests: inputRequestCount,
      },
    });
  }

  /** Project updates live in their own table; an unreadable table must not break the whole context. */
  private async updates(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectUpdateEntity[]> {
    try {
      return await this.ds.getRepository(ProjectUpdateEntity).find({
        where: { workspaceId, projectId },
        order: { createdAt: 'DESC' },
        take: UPDATES_LIMIT,
      });
    } catch (e) {
      this.logger.warn(
        `Project updates unavailable for ${projectId}: ${(e as Error).message}`,
      );
      return [];
    }
  }

  /** Display names for the lead and the authors of the updates shown in the briefing. */
  private async names(ctx: ProjectContextData): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        [ctx.project.leadId, ...ctx.updates.map((u) => u.author?.id)].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    const names = new Map<string, string>();
    if (!ids.length) return names;
    const [users, agents] = await Promise.all([
      this.ds.getRepository(UserEntity).find({ where: { id: In(ids) } }),
      this.ds
        .getRepository(AgentEntity)
        .find({ where: { id: In(ids), workspaceId: ctx.project.workspaceId } }),
    ]);
    for (const x of [...users, ...agents]) names.set(x.id, x.name);
    return names;
  }
}
