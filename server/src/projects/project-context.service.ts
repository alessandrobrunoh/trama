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
  WorkstreamEntity,
} from '../database/entities/index.js';
import {
  assembleProjectContext,
  projectContextMarkdown,
  type ProjectContextData,
} from './project-context.logic.js';

/** Project updates shipped with the context (newest first). */
const UPDATES_LIMIT = 20;

/**
 * "Mega context" of a project: the whole tree Project → Workstreams → Issues → Artifacts
 * (plus the project's own issues and artifacts), milestones, updates, decisions and open input requests.
 */
@Injectable()
export class ProjectContextService {
  private readonly logger = new Logger(ProjectContextService.name);

  constructor(private readonly ds: DataSource) {}

  async build(workspaceId: string, projectId: string): Promise<ProjectContextData> {
    const repo = <T extends object>(e: new () => T) => this.ds.getRepository(e);
    const project = await repo(ProjectEntity).findOneBy({ workspaceId, id: projectId });
    if (!project || projectHidden(currentAccess(), project.id)) throw notFound('Project', projectId);

    const [milestones, workstreams, updates] = await Promise.all([
      repo(MilestoneEntity).find({ where: { workspaceId, projectId }, order: { sortOrder: 'ASC' } }),
      repo(WorkstreamEntity).find({ where: { workspaceId, projectId }, order: { number: 'ASC' } }),
      this.updates(workspaceId, projectId),
    ]);
    const wsIds = workstreams.map((w) => w.id);

    // Issues planned under the project, or linked to one of its workstreams.
    const linked = wsIds.length
      ? await this.ds.query<{ id: string }[]>(
          `SELECT "id" FROM "issues" WHERE "workspaceId" = $1 AND "workstreamIds" ?| $2::text[]`,
          [workspaceId, wsIds],
        )
      : [];
    const issues = await repo(IssueEntity).find({
      where: [{ workspaceId, projectId }, ...(linked.length ? [{ workspaceId, id: In(linked.map((r) => r.id)) }] : [])],
      order: { number: 'ASC' },
    });
    const issueIds = issues.map((i) => i.id);

    const [artifacts, decisions, inputRequests] = await Promise.all([
      repo(ArtifactEntity).find({
        where: [
          { workspaceId, projectId },
          ...(wsIds.length ? [{ workspaceId, workstreamId: In(wsIds) }] : []),
          ...(issueIds.length ? [{ workspaceId, issueId: In(issueIds) }] : []),
        ],
        order: { createdAt: 'ASC' },
      }),
      wsIds.length
        ? repo(DecisionEntity).find({ where: { workspaceId, originWorkstreamId: In(wsIds) }, order: { number: 'ASC' } })
        : [],
      wsIds.length
        ? repo(InputRequestEntity).find({ where: { workspaceId, workstreamId: In(wsIds), state: 'open' }, order: { createdAt: 'ASC' } })
        : [],
    ]);

    return assembleProjectContext({ project, milestones, updates, workstreams, issues, artifacts, decisions, inputRequests });
  }

  /** Markdown briefing for agents (`GET …/context.md`). */
  async markdown(workspaceId: string, projectId: string): Promise<string> {
    const ctx = await this.build(workspaceId, projectId);
    return projectContextMarkdown(ctx, { names: await this.names(ctx) });
  }

  /** Project updates live in their own table; an unreadable table must not break the whole context. */
  private async updates(workspaceId: string, projectId: string): Promise<ProjectUpdateEntity[]> {
    try {
      return await this.ds
        .getRepository(ProjectUpdateEntity)
        .find({ where: { workspaceId, projectId }, order: { createdAt: 'DESC' }, take: UPDATES_LIMIT });
    } catch (e) {
      this.logger.warn(`Project updates unavailable for ${projectId}: ${(e as Error).message}`);
      return [];
    }
  }

  /** Display names for the lead and the authors of the updates shown in the briefing. */
  private async names(ctx: ProjectContextData): Promise<Map<string, string>> {
    const ids = [...new Set([ctx.project.leadId, ...ctx.updates.map((u) => u.author?.id)].filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (!ids.length) return names;
    const [users, agents] = await Promise.all([
      this.ds.getRepository(UserEntity).find({ where: { id: In(ids) } }),
      this.ds.getRepository(AgentEntity).find({ where: { id: In(ids), workspaceId: ctx.project.workspaceId } }),
    ]);
    for (const x of [...users, ...agents]) names.set(x.id, x.name);
    return names;
  }
}
