import { In, type EntityManager } from 'typeorm';
import { unique } from '../common/util.js';
import { IssueEntity, MilestoneEntity } from '../database/entities/index.js';

/**
 * An issue may only be in milestones of its directly assigned project.
 * Drops milestones that no longer belong to that project.
 * Returns the ids of the issues that changed.
 */
export async function pruneIssueMilestones(
  m: EntityManager,
  workspaceId: string,
  issueIds: readonly string[],
): Promise<string[]> {
  if (!issueIds.length) return [];
  const issues = (
    await m
      .getRepository(IssueEntity)
      .findBy({ workspaceId, id: In([...issueIds]) })
  ).filter((i) => i.milestoneIds.length);
  if (!issues.length) return [];
  const milestones = await m
    .getRepository(MilestoneEntity)
    .findBy({
      workspaceId,
      id: In(unique(issues.flatMap((i) => i.milestoneIds))),
    });
  const milestoneProject = new Map(
    milestones.map((ms) => [ms.id, ms.projectId]),
  );
  const changed: string[] = [];
  for (const issue of issues) {
    const kept = issue.milestoneIds.filter((id) => {
      const p = milestoneProject.get(id);
      return !!p && p === issue.projectId;
    });
    if (kept.length === issue.milestoneIds.length) continue;
    await m.update(
      IssueEntity,
      { id: issue.id },
      { milestoneIds: kept, updatedAt: new Date() },
    );
    changed.push(issue.id);
  }
  return changed;
}
