import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { SubjectRef } from '../contracts/domain.js';
import {
  ArtifactEntity,
  CustomerEntity,
  CustomerRequestEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  ProjectUpdateEntity,
  RepositoryEntity,
  TeamEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';

/** Validates cross-entity references inside one workspace (400 on unknown ids). */
@Injectable()
export class RefsService {
  constructor(private readonly ds: DataSource) {}

  private async assertAll(
    target: Parameters<DataSource['getRepository']>[0],
    workspaceId: string,
    ids: readonly string[] | null | undefined,
    label: string,
  ): Promise<void> {
    const unique = [...new Set(ids ?? [])];
    if (!unique.length) return;
    const found = await this.ds
      .getRepository(target)
      .count({ where: { id: In(unique), workspaceId } as never });
    if (found !== unique.length) throw new BadRequestException(`Unknown ${label} in: ${unique.join(', ')}`);
  }

  teams(workspaceId: string, ids?: readonly string[] | null) {
    return this.assertAll(TeamEntity, workspaceId, ids, 'team');
  }

  repositories(workspaceId: string, ids?: readonly string[] | null) {
    return this.assertAll(RepositoryEntity, workspaceId, ids, 'repository');
  }

  projects(workspaceId: string, ids?: readonly string[] | null) {
    return this.assertAll(ProjectEntity, workspaceId, ids, 'project');
  }

  /**
   * A workstream of a project may only use the project's repositories: 400 listing the offenders.
   * Resolves the project (and 400s when it does not exist) so callers can inherit its repositories.
   */
  async projectRepositories(workspaceId: string, projectId: string, repositoryIds: readonly string[]) {
    const project = await this.ds.getRepository(ProjectEntity).findOneBy({ id: projectId, workspaceId });
    if (!project) throw new BadRequestException(`Unknown project in: ${projectId}`);
    const outside = [...new Set(repositoryIds)].filter((r) => !project.repositoryIds.includes(r));
    if (outside.length)
      throw new BadRequestException(
        `Repositories not part of project "${project.name}": ${outside.join(', ')}. Add them to the project first.`,
      );
    return project;
  }

  workstreams(workspaceId: string, ids?: readonly string[] | null) {
    return this.assertAll(WorkstreamEntity, workspaceId, ids, 'workstream');
  }

  /** Users must be members of the workspace. */
  async users(workspaceId: string, ids?: readonly (string | null | undefined)[] | null) {
    const unique = [...new Set((ids ?? []).filter((x): x is string => !!x))];
    if (!unique.length) return;
    const found = await this.ds
      .getRepository(MembershipEntity)
      .count({ where: { workspaceId, userId: In(unique) } });
    if (found !== unique.length) throw new BadRequestException(`Not workspace members: ${unique.join(', ')}`);
  }

  /** Does the subject exist in this workspace, and which workstream does it belong to? */
  async resolveSubject(
    workspaceId: string,
    subject: SubjectRef,
  ): Promise<{ exists: boolean; workstreamId?: string }> {
    const where = { id: subject.id, workspaceId } as never;
    const db = this.ds;
    switch (subject.type) {
      case 'workstream': {
        const r = await db.getRepository(WorkstreamEntity).findOne({ where, select: { id: true } });
        return { exists: !!r, workstreamId: r?.id };
      }
      case 'artifact': {
        const r = await db.getRepository(ArtifactEntity).findOne({ where, select: { id: true, workstreamId: true } });
        return { exists: !!r, workstreamId: r?.workstreamId ?? undefined };
      }
      case 'input_request': {
        const r = await db.getRepository(InputRequestEntity).findOne({ where, select: { id: true, workstreamId: true } });
        return { exists: !!r, workstreamId: r?.workstreamId };
      }
      case 'decision': {
        const r = await db.getRepository(DecisionEntity).findOne({ where });
        return { exists: !!r, workstreamId: r?.originWorkstreamId ?? undefined };
      }
      case 'milestone': {
        return { exists: await db.getRepository(MilestoneEntity).existsBy(where) };
      }
      case 'issue':
        return { exists: await db.getRepository(IssueEntity).existsBy(where) };
      case 'customer':
        return { exists: await db.getRepository(CustomerEntity).existsBy(where) };
      case 'customer_request':
        return { exists: await db.getRepository(CustomerRequestEntity).existsBy(where) };
      case 'repository':
        return { exists: await db.getRepository(RepositoryEntity).existsBy(where) };
      case 'team':
        return { exists: await db.getRepository(TeamEntity).existsBy(where) };
      case 'project':
        return { exists: await db.getRepository(ProjectEntity).existsBy(where) };
      case 'project_update':
        return { exists: await db.getRepository(ProjectUpdateEntity).existsBy(where) };
      case 'import':
        return { exists: (await db.query(`SELECT 1 FROM "import_jobs" WHERE "id" = $1 AND "workspaceId" = $2`, [subject.id, workspaceId])).length > 0 };
    }
  }
}
