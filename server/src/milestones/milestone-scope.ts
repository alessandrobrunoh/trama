import { In, type EntityManager } from 'typeorm';
import { unique } from '../common/util.js';
import { IssueEntity, MilestoneEntity, WorkstreamEntity } from '../database/entities/index.js';

/**
 * An issue may only be in milestones of its own project or of the projects its workstreams belong to.
 * Drops the milestones that no longer qualify (a workstream was unlinked, left its project, or was deleted).
 * Returns the ids of the issues that changed.
 */
export async function pruneIssueMilestones(
  m: EntityManager,
  workspaceId: string,
  issueIds: readonly string[],
): Promise<string[]> {
  if (!issueIds.length) return [];
  const issues = (await m.getRepository(IssueEntity).findBy({ workspaceId, id: In([...issueIds]) })).filter(
    (i) => i.milestoneIds.length,
  );
  if (!issues.length) return [];
  const streamIds = unique(issues.flatMap((i) => i.workstreamIds));
  const streams = streamIds.length ? await m.getRepository(WorkstreamEntity).findBy({ workspaceId, id: In(streamIds) }) : [];
  const projectOf = new Map(streams.map((w) => [w.id, w.projectId]));
  const milestones = await m
    .getRepository(MilestoneEntity)
    .findBy({ workspaceId, id: In(unique(issues.flatMap((i) => i.milestoneIds))) });
  const milestoneProject = new Map(milestones.map((ms) => [ms.id, ms.projectId]));
  const changed: string[] = [];
  for (const issue of issues) {
    const projects = new Set(issue.workstreamIds.map((w) => projectOf.get(w)).filter((p): p is string => !!p));
    if (issue.projectId) projects.add(issue.projectId);
    const kept = issue.milestoneIds.filter((id) => {
      const p = milestoneProject.get(id);
      return !!p && projects.has(p);
    });
    if (kept.length === issue.milestoneIds.length) continue;
    await m.update(IssueEntity, { id: issue.id }, { milestoneIds: kept, updatedAt: new Date() });
    changed.push(issue.id);
  }
  return changed;
}
