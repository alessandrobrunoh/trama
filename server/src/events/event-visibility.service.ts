import { Injectable } from '@nestjs/common';
import { DataSource, In, type EntityTarget, type ObjectLiteral } from 'typeorm';
import type {
  LegacySubjectRef,
  MemberGrant,
  MemberAccess,
  SubjectType,
} from '../contracts/domain.js';
import {
  ArtifactEntity,
  CommentEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectUpdateEntity,
} from '../database/entities/index.js';

interface ScopedEvent {
  subject: LegacySubjectRef;
  data?: Record<string, unknown>;
  type?: string;
}

interface TargetScope {
  /** Empty means a known workspace-level or genuinely unassigned subject. */
  projectIds: (string | null)[];
  mode: 'all' | 'any';
}

const SUBJECT_TYPES = new Set<SubjectType>([
  'issue',
  'artifact',
  'project',
  'project_update',
  'milestone',
  'import',
  'document',
]);

/** Entities that are workspace-wide, rather than owned by a project. */
const UNASSIGNED_SUBJECTS = new Set([
  'document',
  'import',
  'workspace',
  'membership',
  'invite',
  'favorite',
  'customer_subscription',
  'notification',
  'agent',
  'integration',
  'webhook',
  'view',
]);

const MEMBER_VIEW_GRANT: Partial<Record<SubjectType, MemberGrant>> = {
  project: 'projects:view',
  project_update: 'projects:view',
  issue: 'issues:view',
  milestone: 'milestones:view',
  artifact: 'artifacts:view',
  document: 'documents:view',
};

const keyOf = (subject: { type: string; id: string }) =>
  JSON.stringify([subject.type, subject.id]);

function idsOf(subjects: readonly LegacySubjectRef[], type: string): string[] {
  return [...new Set(subjects.filter((s) => s.type === type).map((s) => s.id))];
}

function projectIdsFrom(
  data?: Record<string, unknown>,
): (string | null)[] | undefined {
  const ids = data?.['projectIds'];
  return Array.isArray(ids) &&
    ids.every((id) => id === null || typeof id === 'string')
    ? (ids as (string | null)[])
    : undefined;
}

/**
 * Applies the same project boundary to historical events, snapshots, and live events.
 * A narrowed member never receives an event whose owner cannot be resolved.
 */
@Injectable()
export class EventVisibilityService {
  constructor(private readonly ds: DataSource) {}

  async filterEvents<T extends ScopedEvent>(
    workspaceId: string,
    events: readonly T[],
    access: MemberAccess | null | undefined,
  ): Promise<T[]> {
    if (!access || access.projects.all || events.length === 0)
      return [...events];

    const subjects = [
      ...new Map(
        events.map((event) => [keyOf(event.subject), event.subject]),
      ).values(),
    ];
    const get = <TEntity>(
      target: EntityTarget<TEntity>,
      ids: readonly string[],
      field = 'id',
    ): Promise<TEntity[]> => {
      if (!ids.length) return Promise.resolve([]);
      return this.ds.getRepository(target as EntityTarget<ObjectLiteral>).find({
        where: { workspaceId, [field]: In(ids) } as never,
      }) as Promise<TEntity[]>;
    };

    const [issuesById, milestones, artifacts, projectUpdates] = await Promise.all([
      get(IssueEntity, idsOf(subjects, 'issue')),
      get(MilestoneEntity, idsOf(subjects, 'milestone')),
      get(ArtifactEntity, idsOf(subjects, 'artifact')),
      get(ProjectUpdateEntity, idsOf(subjects, 'project_update')),
    ]);

    const issueIds = new Set<string>();
    for (const row of artifacts) if (row.issueId) issueIds.add(row.issueId);
    const relatedIssues = issueIds.size
      ? await this.ds.getRepository(IssueEntity).find({
          where: { workspaceId, id: In([...issueIds]) },
        })
      : [];
    const allIssues = new Map(
      [...issuesById, ...relatedIssues].map((row) => [row.id, row]),
    );

    const rowMaps = {
      issue: allIssues,
      milestone: new Map(milestones.map((row) => [row.id, row])),
      artifact: new Map(artifacts.map((row) => [row.id, row])),
      project_update: new Map(projectUpdates.map((row) => [row.id, row])),
    };
    const scopes = new Map<string, TargetScope | null>();

    const scopeFor = (
      subject: LegacySubjectRef,
      data?: Record<string, unknown>,
      seen = new Set<string>(),
    ): TargetScope | null => {
      const key = keyOf(subject);
      const cacheKey = JSON.stringify([
        key,
        data?.['projectId'],
        data?.['issueId'],
        data?.['issueIds'],
        data?.['projectIds'],
      ]);
      if (scopes.has(cacheKey)) return scopes.get(cacheKey) ?? null;
      if (seen.has(key)) return null;
      seen.add(key);
      const row = rowMaps[subject.type as keyof typeof rowMaps]?.get(
        subject.id,
      );
      const dataProject =
        data && Object.hasOwn(data, 'projectId')
          ? typeof data['projectId'] === 'string'
            ? data['projectId']
            : null
          : undefined;
      let scope: TargetScope | null;

      switch (subject.type) {
        case 'project':
          scope = { projectIds: [subject.id], mode: 'all' };
          break;
        case 'issue': {
          const issue = row as IssueEntity | undefined;
          const projectId = issue ? issue.projectId : dataProject;
          scope =
            projectId === undefined
              ? null
              : { projectIds: [projectId], mode: 'all' };
          break;
        }
        case 'milestone': {
          const milestone = row as MilestoneEntity | undefined;
          const projectId = milestone?.projectId ?? dataProject;
          scope =
            projectId === undefined
              ? null
              : { projectIds: [projectId], mode: 'all' };
          break;
        }
        case 'artifact': {
          const artifact = row as ArtifactEntity | undefined;
          if (!artifact) {
            const issueId =
              typeof data?.['issueId'] === 'string'
                ? data['issueId']
                : undefined;
            const targets: (string | null)[] = [];
            if (issueId) {
              const issue = allIssues.get(issueId);
              if (!issue) {
                scope = null;
                break;
              }
              targets.push(issue.projectId);
            }
            if (dataProject !== undefined && (dataProject !== null || !issueId))
              targets.push(dataProject);
            scope = targets.length
              ? { projectIds: targets, mode: 'all' }
              : null;
            break;
          }
          const targets: (string | null)[] = [];
          if (artifact.projectId) targets.push(artifact.projectId);
          if (artifact.issueId) {
            const issue = allIssues.get(artifact.issueId);
            if (!issue) {
              scope = null;
              break;
            }
            targets.push(issue.projectId);
          }
          scope = { projectIds: targets, mode: 'all' };
          break;
        }
        case 'project_update': {
          const update = row as ProjectUpdateEntity | undefined;
          const projectId = update?.projectId ?? dataProject;
          scope = projectId ? { projectIds: [projectId], mode: 'all' } : null;
          break;
        }
        default:
          scope = UNASSIGNED_SUBJECTS.has(subject.type)
            ? { projectIds: [], mode: 'all' }
            : null;
      }
      scopes.set(cacheKey, scope);
      return scope;
    };

    const canSee = (scope: TargetScope | null): boolean => {
      if (!scope) return false;
      if (scope.projectIds.length === 0) return access.includeUnassigned;
      const visible = (id: string | null) =>
        id === null
          ? access.includeUnassigned
          : access.projects.projectIds.includes(id);
      return scope.mode === 'all'
        ? scope.projectIds.every(visible)
        : scope.projectIds.some(visible);
    };

    return events.filter((event) => {
      const resourceGrant =
        MEMBER_VIEW_GRANT[event.subject.type as SubjectType];
      if (resourceGrant && !access.grants.includes(resourceGrant)) return false;
      if (
        event.type?.startsWith('comment.') &&
        !access.grants.includes('comments:view')
      )
        return false;
      return canSee(scopeFor(event.subject, event.data));
    });
  }

  async isLiveVisible(
    workspaceId: string,
    event: { entity: string; id: string; type: string },
    access: MemberAccess | null | undefined,
    scopeSubject?: LegacySubjectRef,
  ): Promise<boolean> {
    if (!access || access.projects.all) return true;
    let subject = scopeSubject;
    if (!subject && SUBJECT_TYPES.has(event.entity as SubjectType))
      subject = { type: event.entity as SubjectType, id: event.id };
    if (!subject && event.entity === 'comment') {
      const comment = await this.ds.getRepository(CommentEntity).findOneBy({
        workspaceId,
        id: event.id,
      });
      subject = comment?.subject;
    }
    if (!subject)
      return access.includeUnassigned && UNASSIGNED_SUBJECTS.has(event.entity);
    const visibilityType =
      event.entity === 'comment'
        ? 'comment.updated'
        : `${event.entity}.${event.type}`;
    const visible = await this.filterEvents(
      workspaceId,
      [{ subject, type: visibilityType }],
      access,
    );
    return visible.length === 1;
  }
}
