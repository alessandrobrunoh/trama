import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { SubjectRef } from '../contracts/domain.js';
import {
  ArtifactEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MembershipEntity,
  MilestoneEntity,
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
        return { exists: !!r, workstreamId: r?.workstreamId };
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
        const r = await db.getRepository(MilestoneEntity).findOne({ where, select: { id: true, workstreamId: true } });
        return { exists: !!r, workstreamId: r?.workstreamId };
      }
      case 'issue':
        return { exists: await db.getRepository(IssueEntity).existsBy(where) };
      case 'repository':
        return { exists: await db.getRepository(RepositoryEntity).existsBy(where) };
      case 'team':
        return { exists: await db.getRepository(TeamEntity).existsBy(where) };
    }
  }
}
