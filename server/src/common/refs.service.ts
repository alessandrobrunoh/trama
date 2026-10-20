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
  ReleaseEntity,
  ReleasePipelineEntity,
  DocumentEntity,
  ProjectUpdateEntity,
  RepositoryEntity,
  TeamEntity,
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
    if (found !== unique.length)
      throw new BadRequestException(
        `Unknown ${label} in: ${unique.join(', ')}`,
      );
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

  issues(workspaceId: string, ids?: readonly string[] | null) {
    return this.assertAll(IssueEntity, workspaceId, ids, 'issue');
  }

  /** Users must be members of the workspace. */
  async users(
    workspaceId: string,
    ids?: readonly (string | null | undefined)[] | null,
  ) {
    const unique = [...new Set((ids ?? []).filter((x): x is string => !!x))];
    if (!unique.length) return;
    const found = await this.ds
      .getRepository(MembershipEntity)
      .count({ where: { workspaceId, userId: In(unique) } });
    if (found !== unique.length)
      throw new BadRequestException(
        `Not workspace members: ${unique.join(', ')}`,
      );
  }

  /** Does the subject exist in this workspace? */
  async resolveSubject(
    workspaceId: string,
    subject: SubjectRef,
  ): Promise<{ exists: boolean }> {
    const where = { id: subject.id, workspaceId } as never;
    const db = this.ds;
    switch (subject.type) {
      case 'artifact': {
        return {
          exists: await db.getRepository(ArtifactEntity).existsBy(where),
        };
      }
      case 'input_request': {
        return {
          exists: await db.getRepository(InputRequestEntity).existsBy(where),
        };
      }
      case 'decision': {
        return {
          exists: await db.getRepository(DecisionEntity).existsBy(where),
        };
      }
      case 'milestone': {
        return {
          exists: await db.getRepository(MilestoneEntity).existsBy(where),
        };
      }
      case 'release':
        return {
          exists: await db.getRepository(ReleaseEntity).existsBy(where),
        };
      case 'release_pipeline':
        return {
          exists: await db.getRepository(ReleasePipelineEntity).existsBy(where),
        };
      case 'issue':
        return { exists: await db.getRepository(IssueEntity).existsBy(where) };
      case 'customer':
        return {
          exists: await db.getRepository(CustomerEntity).existsBy(where),
        };
      case 'customer_request':
        return {
          exists: await db.getRepository(CustomerRequestEntity).existsBy(where),
        };
      case 'repository':
        return {
          exists: await db.getRepository(RepositoryEntity).existsBy(where),
        };
      case 'team':
        return { exists: await db.getRepository(TeamEntity).existsBy(where) };
      case 'project':
        return {
          exists: await db.getRepository(ProjectEntity).existsBy(where),
        };
      case 'project_update':
        return {
          exists: await db.getRepository(ProjectUpdateEntity).existsBy(where),
        };
      case 'import':
        return {
          exists:
            (
              await db.query(
                `SELECT 1 FROM "import_jobs" WHERE "id" = $1 AND "workspaceId" = $2`,
                [subject.id, workspaceId],
              )
            ).length > 0,
        };
      case 'document':
        return {
          exists: await db.getRepository(DocumentEntity).existsBy(where),
        };
      default:
        return { exists: false };
    }
  }
}
