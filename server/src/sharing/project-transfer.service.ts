import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import { projectHidden } from '../auth/member-access.js';
import {
  effectiveMemberAccess,
  findWorkspaceRole,
  roleHasAdminPower,
  type ActorRef,
  type ID,
  type IssueStatus,
  type ProjectHealth,
  type ProjectStatus,
  type ProjectTransferGuest,
  type ProjectTransferPreview,
  type ProjectTransferResult,
} from '../contracts/domain.js';
import { isUniqueViolation, notFound, uid, unique } from '../common/util.js';
import {
  IssueEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import {
  guestRoleFor,
  limitedProjectIds,
  planTransferMappings,
  type TransferMappingPlan,
} from './project-transfer-plan.js';

interface CarriedGuest extends ProjectTransferGuest {
  /** The membership in the source workspace. */
  from: MembershipEntity;
  /** The membership in the target, when there is one. */
  existing?: MembershipEntity;
}

interface Plan {
  source: WorkspaceEntity;
  target: WorkspaceEntity;
  project: ProjectEntity;
  issues: IssueEntity[];
  milestoneIds: ID[];
  mapping: TransferMappingPlan;
  guests: CarriedGuest[];
  /** Everyone who is a member of the target once the guests are carried over. */
  targetPeople: Set<ID>;
  preview: ProjectTransferPreview;
}

/**
 * Moves a project, with its milestones, issues, time entries, comments, artifacts and history, to another
 * workspace. The caller must be able to administer both workspaces. Issue keys are kept (so the project tag
 * must be free in the target), statuses and labels are mapped to the target's by type and name, guests are
 * carried over as limited members, and anything that pointed at a person who is not in the target is cleared.
 * One transaction: either everything moves or nothing does.
 */
@Injectable()
export class ProjectTransferService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  async preview(ctx: WorkspaceContext, projectId: string, targetSlug: string): Promise<ProjectTransferPreview> {
    const { source, target, project } = await this.resolve(this.ds.manager, ctx, projectId, targetSlug);
    return (await this.plan(this.ds.manager, source, target, project, ctx.userId!, false)).preview;
  }

  async transfer(
    ctx: WorkspaceContext,
    actor: ActorRef,
    projectId: string,
    targetSlug: string,
  ): Promise<ProjectTransferResult> {
    const resolved = await this.resolve(this.ds.manager, ctx, projectId, targetSlug);
    const callerId = ctx.userId!;
    let outcome: { plan: Plan; project: ProjectEntity; timeEntries: number; unassigned: number };
    try {
      outcome = await this.ds.transaction(async (m) => {
        // serialize transfers touching either workspace; plain writes (issue creation) keep going
        await m.query(
          `SELECT "id" FROM "workspaces" WHERE "id" = ANY($1) ORDER BY "id" FOR NO KEY UPDATE`,
          [[resolved.source.id, resolved.target.id]],
        );
        const source = await m.findOneByOrFail(WorkspaceEntity, { id: resolved.source.id });
        const target = await m.findOneByOrFail(WorkspaceEntity, { id: resolved.target.id });
        const locked = (await m.query(
          `SELECT "id" FROM "projects" WHERE "workspaceId" = $1 AND "id" = $2 FOR UPDATE`,
          [source.id, projectId],
        )) as { id: string }[];
        if (!locked[0]) throw notFound('Project', projectId);
        const project = await m.findOneByOrFail(ProjectEntity, { id: projectId });
        const plan = await this.plan(m, source, target, project, callerId, true);
        if (plan.preview.blockers.length) throw new ConflictException(plan.preview.blockers.join(' '));
        const moved = await this.apply(m, plan);
        return { plan, ...moved };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          'Something in this project already exists in the target workspace (an issue key or an imported issue)',
        );
      throw error;
    }
    const { plan, project, timeEntries, unassigned } = outcome;
    await this.announce(plan, actor);
    return {
      // The entity is what every project route returns; nullable columns serialize the same way.
      project: project as unknown as ProjectTransferResult['project'],
      target: { id: plan.target.id, slug: plan.target.slug, name: plan.target.name },
      counts: { issues: plan.issues.length, milestones: plan.milestoneIds.length, timeEntries },
      unassigned,
    };
  }

  // ───────── permissions

  /** Both workspaces and the project, or an error. The caller already administers the source (route gate). */
  private async resolve(m: EntityManager, ctx: WorkspaceContext, projectId: string, targetSlug: string) {
    const source = ctx.workspace;
    const project = await m.findOneBy(ProjectEntity, { workspaceId: source.id, id: projectId });
    if (!project || projectHidden(ctx.access, project.id)) throw notFound('Project', projectId);
    const target = await m.findOneBy(WorkspaceEntity, { slug: targetSlug.trim().toLowerCase() });
    const mine = target ? await m.findOneBy(MembershipEntity, { workspaceId: target.id, userId: ctx.userId }) : null;
    // a workspace the caller does not belong to looks like one that does not exist
    if (!target || !mine) throw new NotFoundException(`Workspace "${targetSlug}" not found`);
    if (target.id === source.id) throw new BadRequestException('The project already lives in that workspace');
    const role = findWorkspaceRole(target.resolved().roles, mine.role);
    const access = effectiveMemberAccess(role, mine.access);
    if (!role || !roleHasAdminPower(role) || (access && !access.projects.all))
      throw new ForbiddenException('You need to be an owner or admin of the target workspace to transfer a project into it');
    return { source, target, project };
  }

  // ───────── planning

  private async plan(
    m: EntityManager,
    source: WorkspaceEntity,
    target: WorkspaceEntity,
    project: ProjectEntity,
    callerId: string,
    lock: boolean,
  ): Promise<Plan> {
    const issues = await m.find(IssueEntity, {
      where: { workspaceId: source.id, projectId: project.id },
      order: { createdAt: 'ASC', id: 'ASC' },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    const milestoneIds = (await m.findBy(MilestoneEntity, { projectId: project.id })).map((row) => row.id);
    const issueIds = issues.map((issue) => issue.id);
    const [{ count }] = (await m.query(
      `SELECT count(*)::int AS "count" FROM "time_entries"
        WHERE "workspaceId" = $1 AND ("projectId" = $2 OR "issueId" = ANY($3))`,
      [source.id, project.id, issueIds],
    )) as { count: number }[];

    const issueStatuses = new Map<string, number>();
    const labelUse = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const issue of issues) {
      bump(issueStatuses, issue.status);
      for (const id of issue.labels) bump(labelUse, id);
    }
    for (const id of project.labels) bump(labelUse, id);
    const mapping = planTransferMappings(
      source.resolved(),
      target.resolved(),
      { issueStatuses, projectStatus: project.status, projectHealth: project.health, labels: labelUse },
      () => uid('lb'),
    );

    const blockers = [...mapping.blockers];
    if (await m.existsBy(ProjectEntity, { workspaceId: target.id, key: project.key }))
      blockers.push(`The project tag ${project.key} is already used in ${target.name}. Change the tag first.`);
    const clash = (await m.query(
      `SELECT 1 FROM "issues" i
        WHERE i."workspaceId" = $1
          AND (i."key" ~ $2
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(i."aliases", '[]'::jsonb)) AS a(v) WHERE a.v ~ $2))
        LIMIT 1`,
      [target.id, `^${project.key}-[0-9]+$`],
    )) as unknown[];
    if (clash.length) blockers.push(`${target.name} already has issues keyed ${project.key}-…, so the keys would collide.`);

    const guests = await this.guestsOf(m, source, target, project, callerId, blockers);
    const targetPeople = new Set<ID>(
      (await m.findBy(MembershipEntity, { workspaceId: target.id })).map((row) => row.userId),
    );
    for (const guest of guests) targetPeople.add(guest.userId);

    const unassigned =
      issues.filter(
        (issue) =>
          (issue.assigneeId && !targetPeople.has(issue.assigneeId)) ||
          (issue.reporterId && !targetPeople.has(issue.reporterId)),
      ).length + (project.leadId && !targetPeople.has(project.leadId) ? 1 : 0);

    return {
      source,
      target,
      project,
      issues,
      milestoneIds,
      mapping,
      guests,
      targetPeople,
      preview: {
        project: { id: project.id, name: project.name, key: project.key },
        source: { id: source.id, slug: source.slug, name: source.name },
        target: { id: target.id, slug: target.slug, name: target.name },
        counts: { issues: issues.length, milestones: milestoneIds.length, timeEntries: count },
        mappings: mapping.mappings,
        guests: guests.map(({ userId, name, email, action, role }) => ({ userId, name, email, action, role })),
        unassigned,
        blockers,
      },
    };
  }

  /** People limited to this project in the source: they keep their way in, as limited members of the target. */
  private async guestsOf(
    m: EntityManager,
    source: WorkspaceEntity,
    target: WorkspaceEntity,
    project: ProjectEntity,
    callerId: string,
    blockers: string[],
  ): Promise<CarriedGuest[]> {
    const sourceRoles = source.resolved().roles;
    const targetRoles = target.resolved().roles;
    const carried = (await m.findBy(MembershipEntity, { workspaceId: source.id })).filter(
      (row) => row.userId !== callerId && limitedProjectIds(sourceRoles, row)?.includes(project.id),
    );
    if (!carried.length) return [];
    const users = new Map(
      (await m.findBy(UserEntity, { id: In(carried.map((row) => row.userId)) })).map((user) => [user.id, user]),
    );
    const existing = new Map(
      (await m.findBy(MembershipEntity, { workspaceId: target.id, userId: In(carried.map((row) => row.userId)) })).map(
        (row) => [row.userId, row],
      ),
    );
    const out: CarriedGuest[] = [];
    for (const from of carried) {
      const user = users.get(from.userId);
      if (!user) continue;
      const there = existing.get(from.userId);
      const base = { userId: user.id, name: user.name, email: user.email, from };
      if (!there) {
        const role = guestRoleFor(targetRoles, from.role);
        if (!role) {
          blockers.push(
            `${target.name} has no role a guest can hold (everything there is an owner or admin role), so ${user.name} could not be carried over.`,
          );
          continue;
        }
        out.push({ ...base, action: 'add', role });
      } else if (limitedProjectIds(targetRoles, there) === null) {
        out.push({ ...base, action: 'keep', role: there.role, existing: there });
      } else {
        out.push({ ...base, action: 'extend', role: there.role, existing: there });
      }
    }
    return out;
  }

  // ───────── applying

  private async apply(
    m: EntityManager,
    plan: Plan,
  ): Promise<{ project: ProjectEntity; timeEntries: number; unassigned: number }> {
    const { source, target, project, issues, milestoneIds, mapping, targetPeople } = plan;
    const issueIds = issues.map((issue) => issue.id);
    const inMoved = new Set(issueIds);
    const milestones = new Set(milestoneIds);
    const sub = { src: source.id, tgt: target.id };

    if (mapping.newLabels.length) {
      const stored = target.resolved().labels;
      const settings: WorkspaceEntity['settings'] = { ...target.settings, labels: [...stored, ...mapping.newLabels] };
      await m.update(WorkspaceEntity, { id: target.id }, { settings });
    }

    // people who are not in the target are cleared rather than left dangling
    let unassigned = 0;
    for (const issue of issues) {
      const lost = !!(
        (issue.assigneeId && !targetPeople.has(issue.assigneeId)) ||
        (issue.reporterId && !targetPeople.has(issue.reporterId))
      );
      if (lost) unassigned++;
      if (issue.assigneeId && !targetPeople.has(issue.assigneeId)) issue.assigneeId = null;
      if (issue.reporterId && !targetPeople.has(issue.reporterId)) issue.reporterId = null;
      issue.status = (mapping.statuses.issue.get(issue.status) ?? issue.status) as IssueStatus;
      issue.labels = unique(issue.labels.map((id) => mapping.labels.get(id) ?? null).filter((id): id is string => !!id));
      issue.milestoneIds = issue.milestoneIds.filter((id) => milestones.has(id));
      // the parent link only works inside one workspace
      if (issue.parentId && !inMoved.has(issue.parentId)) issue.parentId = null;
      if (issue.duplicateOfId && !inMoved.has(issue.duplicateOfId)) issue.duplicateOfId = null;
    }
    if (issues.length) await m.save(IssueEntity, issues, { chunk: 200 });
    if (issueIds.length) {
      // issues elsewhere that point at a moved one lose that link (same-workspace foreign key)
      await m.query(
        `UPDATE "issues" SET "parentId" = NULL WHERE "workspaceId" = $1 AND "parentId" = ANY($2) AND NOT ("id" = ANY($2))`,
        [sub.src, issueIds],
      );
      await m.query(
        `UPDATE "issues" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = ANY($2) AND NOT ("id" = ANY($2))`,
        [sub.src, issueIds],
      );
      // one statement, so a parent and its children move together
      await m.query(`UPDATE "issues" SET "workspaceId" = $1 WHERE "workspaceId" = $2 AND "id" = ANY($3)`, [
        sub.tgt,
        sub.src,
        issueIds,
      ]);
    }

    await m.query(`UPDATE "milestones" SET "workspaceId" = $1 WHERE "projectId" = $2`, [sub.tgt, project.id]);

    // written updates move with the project; the health each reported follows the mapping, or is dropped
    // when the target has no such health
    const targetHealth = new Set(target.resolved().statuses.projectHealth.map((entry) => entry.id));
    const reported = (
      (await m.query(
        `SELECT DISTINCT "health" FROM "project_updates" WHERE "projectId" = $1 AND "health" IS NOT NULL`,
        [project.id],
      )) as { health: string }[]
    ).map((row) => row.health);
    for (const health of reported) {
      const next = mapping.statuses.project_health.get(health) ?? health;
      await m.query(`UPDATE "project_updates" SET "health" = $3 WHERE "projectId" = $1 AND "health" = $2`, [
        project.id,
        health,
        targetHealth.has(next) ? next : null,
      ]);
    }
    await m.query(`UPDATE "project_updates" SET "workspaceId" = $1 WHERE "projectId" = $2`, [sub.tgt, project.id]);

    await m.update(ProjectEntity, { id: project.id }, {
      workspaceId: target.id,
      status: (mapping.statuses.project.get(project.status) ?? project.status) as ProjectStatus,
      health: project.health
        ? ((mapping.statuses.project_health.get(project.health) ?? project.health) as ProjectHealth)
        : null,
      labels: unique(project.labels.map((id) => mapping.labels.get(id) ?? null).filter((id): id is string => !!id)),
      leadId: project.leadId && targetPeople.has(project.leadId) ? project.leadId : null,
      updatedAt: new Date(),
    });

    const timeEntries = firstColumn(
      await m.query(
        `UPDATE "time_entries" SET "workspaceId" = $1, "projectId" = $3
          WHERE "workspaceId" = $2 AND ("projectId" = $3 OR "issueId" = ANY($4)) RETURNING "id"`,
        [sub.tgt, sub.src, project.id, issueIds],
      ),
    );

    const artifactIds = firstColumn(
      await m.query(
        `UPDATE "artifacts" SET "workspaceId" = $1 WHERE "workspaceId" = $2 AND "issueId" = ANY($3) RETURNING "id"`,
        [sub.tgt, sub.src, issueIds],
      ),
    );
    if (artifactIds.length)
      await m.query(`UPDATE "artifact_sources" SET "workspaceId" = $1 WHERE "artifactId" = ANY($2)`, [
        sub.tgt,
        artifactIds,
      ]);

    const subjects = [project.id, ...milestoneIds, ...issueIds, ...artifactIds];
    const commentIds = firstColumn(
      await m.query(
        `UPDATE "comments" SET "workspaceId" = $1 WHERE "workspaceId" = $2 AND "subject"->>'id' = ANY($3) RETURNING "id"`,
        [sub.tgt, sub.src, subjects],
      ),
    );
    await m.query(`UPDATE "domain_events" SET "workspaceId" = $1 WHERE "workspaceId" = $2 AND "subject"->>'id' = ANY($3)`, [
      sub.tgt,
      sub.src,
      subjects,
    ]);

    // an edge with one end left behind cannot work across workspaces
    await m.query(
      `DELETE FROM "dependencies" WHERE "workspaceId" = $1 AND (("fromId" = ANY($2)) <> ("toId" = ANY($2)))`,
      [sub.src, subjects],
    );
    await m.query(
      `UPDATE "dependencies" SET "workspaceId" = $1 WHERE "workspaceId" = $2 AND "fromId" = ANY($3) AND "toId" = ANY($3)`,
      [sub.tgt, sub.src, subjects],
    );

    // files follow the records that use them, unless something staying behind still does
    const referencing = [...subjects, ...commentIds];
    await m.query(
      `UPDATE "uploads" u SET "workspaceId" = $1
        WHERE u."workspaceId" = $2
          AND EXISTS (SELECT 1 FROM "upload_references" r WHERE r."uploadId" = u."id" AND r."workspaceId" = $2 AND r."subjectId" = ANY($3))
          AND NOT EXISTS (SELECT 1 FROM "upload_references" r WHERE r."uploadId" = u."id" AND r."workspaceId" = $2 AND NOT (r."subjectId" = ANY($3)))`,
      [sub.tgt, sub.src, referencing],
    );
    await m.query(
      `UPDATE "upload_references" r SET "workspaceId" = $1
        WHERE r."workspaceId" = $2 AND r."subjectId" = ANY($3)
          AND EXISTS (SELECT 1 FROM "uploads" u WHERE u."id" = r."uploadId" AND u."workspaceId" = $1)`,
      [sub.tgt, sub.src, referencing],
    );
    await m.query(`DELETE FROM "upload_references" WHERE "workspaceId" = $1 AND "subjectId" = ANY($2)`, [
      sub.src,
      referencing,
    ]);

    // pins and inbox items are per person and per workspace: they would point at the old address
    await m.query(`DELETE FROM "favorites" WHERE "workspaceId" = $1 AND "subjectId" = ANY($2)`, [sub.src, subjects]);
    await m.query(`DELETE FROM "notifications" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`, [
      sub.src,
      referencing,
    ]);

    // the next issue in the project continues after the highest number either side has used
    await m.query(
      `INSERT INTO "workspace_counters" ("workspaceId", "name", "value")
       SELECT $1, "name", "value" FROM "workspace_counters" WHERE "workspaceId" = $2 AND "name" = $3
       ON CONFLICT ("workspaceId", "name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", EXCLUDED."value")`,
      [sub.tgt, sub.src, `issue-key:${project.key}`],
    );

    await this.carryGuests(m, plan);

    // someone who had put this project in the target workspace now simply sees it there
    await m.query(`DELETE FROM "project_placements" WHERE "projectId" = $1 AND "workspaceId" = $2`, [
      project.id,
      target.id,
    ]);

    return {
      project: await m.findOneByOrFail(ProjectEntity, { id: project.id }),
      timeEntries: timeEntries.length,
      unassigned,
    };
  }

  private async carryGuests(m: EntityManager, plan: Plan): Promise<void> {
    const { project, target } = plan;
    for (const guest of plan.guests) {
      if (guest.action === 'add') {
        await m.save(
          m.create(MembershipEntity, {
            id: uid('mb'),
            workspaceId: target.id,
            userId: guest.userId,
            role: guest.role,
            access: { projects: { all: false, projectIds: [project.id] }, includeUnassigned: false, grants: [] },
          }),
        );
      } else if (guest.action === 'extend' && guest.existing?.access) {
        const access = guest.existing.access;
        guest.existing.access = {
          ...access,
          projects: { all: false, projectIds: unique([...access.projects.projectIds, project.id]) },
        };
        await m.save(guest.existing);
      }
      // their way into the source project is gone with it
      const access = guest.from.access;
      if (!access) continue;
      const remaining = access.projects.projectIds.filter((id) => id !== project.id);
      if (guest.from.role === 'guest' && !remaining.length && !access.includeUnassigned) {
        await m.delete(MembershipEntity, { id: guest.from.id });
      } else {
        guest.from.access = { ...access, projects: { all: false, projectIds: remaining } };
        await m.save(guest.from);
      }
    }
  }

  // ───────── after commit

  private async announce(plan: Plan, actor: ActorRef): Promise<void> {
    const { source, target, project } = plan;
    await this.events.record(
      {
        workspaceId: target.id,
        actor,
        type: 'project.transferred',
        subject: { type: 'project', id: project.id },
        data: {
          name: project.name,
          key: project.key,
          from: { id: source.id, slug: source.slug, name: source.name },
          issues: plan.issues.length,
        },
      },
      false,
    );
    this.events.publish(source.id, { type: 'deleted', entity: 'project', id: project.id });
    this.events.publish(source.id, { type: 'updated', entity: 'workspace', id: source.id });
    this.events.publish(target.id, { type: 'created', entity: 'project', id: project.id });
    this.events.publish(target.id, { type: 'updated', entity: 'workspace', id: target.id });
    for (const guest of plan.guests) {
      if (guest.action === 'add')
        this.events.publish(target.id, { type: 'created', entity: 'membership', id: guest.userId });
    }
  }
}

/** `UPDATE … RETURNING id` through TypeORM's `query` gives `[rows, affected]` on Postgres. */
function firstColumn(result: unknown): string[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as { id: string }[]) : (result as { id: string }[]);
  return rows.map((row) => row.id);
}
