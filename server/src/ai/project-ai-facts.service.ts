import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, type Repository } from 'typeorm';
import { PROJECT_HEALTHS, type ProjectHealth } from '../contracts/domain.js';
import {
  DecisionEntity,
  DomainEventEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  UserEntity,
} from '../database/entities/index.js';
import { record } from './ai-provider.js';
import {
  clip,
  type FactsIssue,
  type ProjectFacts,
} from './project-ai.logic.js';

const MAX_PROJECT_ISSUES = 500;
const MAX_CANDIDATES = 150;

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;
const isHealth = (value: unknown): value is ProjectHealth =>
  typeof value === 'string' && (PROJECT_HEALTHS as string[]).includes(value);

/** Reads everything the project AI needs straight from the repositories. Read-only. */
@Injectable()
export class ProjectAiFactsService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(MilestoneEntity)
    private readonly milestones: Repository<MilestoneEntity>,
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
    @InjectRepository(InputRequestEntity)
    private readonly inputRequests: Repository<InputRequestEntity>,
    @InjectRepository(DecisionEntity)
    private readonly decisions: Repository<DecisionEntity>,
    @InjectRepository(DomainEventEntity)
    private readonly events: Repository<DomainEventEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  /** `withCandidates`: also load open issues outside the project (for the `issues` suggestion). */
  async gather(
    project: ProjectEntity,
    withCandidates: boolean,
  ): Promise<ProjectFacts> {
    const workspaceId = project.workspaceId;
    const [milestones, issues] = await Promise.all([
      this.milestones.find({
        where: { workspaceId, projectId: project.id },
        order: { sortOrder: 'ASC' },
        take: 50,
      }),
      this.issues.find({
        where: { workspaceId, projectId: project.id },
        order: { updatedAt: 'DESC' },
        take: MAX_PROJECT_ISSUES,
      }),
    ]);
    const issueIds = issues.map((i) => i.id);
    const [inputRequests, decisions, events, updates, candidates] =
      await Promise.all([
        issueIds.length
          ? this.inputRequests.find({
              where: {
                workspaceId,
                issueId: In(issueIds),
                state: 'open',
              },
              order: { createdAt: 'ASC' },
              take: 50,
            })
          : [],
        issueIds.length
          ? this.decisions.find({
              where: { workspaceId, originIssueId: In(issueIds) },
              order: { createdAt: 'DESC' },
              take: 10,
            })
          : [],
        this.recentEvents(workspaceId, project.id, issueIds),
        this.recentUpdates(workspaceId, project.id),
        withCandidates ? this.candidateIssues(workspaceId) : [],
      ]);

    const userIds = new Set<string>();
    if (project.leadId) userIds.add(project.leadId);
    for (const i of [...issues, ...candidates])
      if (i.assigneeId) userIds.add(i.assigneeId);
    const names = new Map<string, string>();
    if (userIds.size)
      for (const u of await this.users.find({
        where: { id: In([...userIds]) },
        select: { id: true, name: true },
      }))
        names.set(u.id, u.name);

    const toIssue = (i: IssueEntity): FactsIssue => ({
      id: i.id,
      key: i.key,
      title: i.title,
      status: i.status,
      priority: i.priority,
      assigneeId: i.assigneeId,
      assignee: i.assigneeId ? (names.get(i.assigneeId) ?? null) : null,
      milestoneIds: i.milestoneIds ?? [],
      updatedAt: i.updatedAt.toISOString(),
    });

    // `health` / `lastUpdateAt` may live on the project row once project updates exist; the newest update wins.
    const row = record(project) ?? {};
    const latest = updates[0];
    const rowHealth = row['health'];
    const rowLast = row['lastUpdateAt'];
    return {
      project: {
        id: project.id,
        name: project.name,
        summary: project.summary,
        description: project.description,
        status: project.status,
        priority: project.priority,
        health: isHealth(latest?.health)
          ? latest.health
          : isHealth(rowHealth)
            ? rowHealth
            : null,
        lead: project.leadId ? (names.get(project.leadId) ?? null) : null,
        startDate: iso(project.startDate),
        targetDate: iso(project.targetDate),
        createdAt: project.createdAt.toISOString(),
        lastUpdateAt:
          latest?.createdAt ??
          (rowLast instanceof Date
            ? rowLast.toISOString()
            : typeof rowLast === 'string'
              ? rowLast
              : null),
      },
      milestones: milestones.map((m) => ({
        id: m.id,
        name: m.name,
        targetDate: iso(m.targetDate),
      })),
      issues: issues.map(toIssue),
      updates: updates.map((u) => ({
        health: u.health,
        body: u.body,
        createdAt: u.createdAt,
      })),
      decisions: decisions.map((d) => ({
        key: d.key,
        title: d.title,
        status: d.status,
        at: d.createdAt.toISOString(),
      })),
      inputRequests: inputRequests.map((r) => ({
        issueKey: issues.find((i) => i.id === r.issueId)?.key ?? '',
        question: r.question,
        createdAt: r.createdAt.toISOString(),
      })),
      events: events.map((e) => ({
        at: e.at.toISOString(),
        type: e.type,
        summary: this.eventSummary(e),
      })),
      candidates: candidates.map(toIssue),
    };
  }

  private async candidateIssues(workspaceId: string): Promise<IssueEntity[]> {
    const rows = await this.issues.find({
      where: { workspaceId, status: Not(In(['done', 'canceled'])) },
      order: { updatedAt: 'DESC' },
      take: MAX_CANDIDATES * 3,
    });
    return rows
      .filter((i) => !i.projectId && !i.duplicateOfId)
      .slice(0, MAX_CANDIDATES);
  }

  private recentEvents(
    workspaceId: string,
    projectId: string,
    issueIds: string[],
  ) {
    const query = this.events
      .createQueryBuilder('e')
      .where('e.workspaceId = :workspaceId', { workspaceId });
    if (issueIds.length)
      query.andWhere(
        `(e.subject ->> 'id' IN (:...issueIds) OR e.subject ->> 'id' = :projectId)`,
        { issueIds, projectId },
      );
    else query.andWhere(`e.subject ->> 'id' = :projectId`, { projectId });
    return query.orderBy('e.at', 'DESC').take(25).getMany();
  }

  /** `project_updates` is created by the project-updates feature; tolerate it not existing yet. */
  private async recentUpdates(workspaceId: string, projectId: string) {
    try {
      const rows: unknown = await this.ds.query(
        'SELECT * FROM "project_updates" WHERE "workspaceId" = $1 AND "projectId" = $2 ORDER BY "createdAt" DESC LIMIT 5',
        [workspaceId, projectId],
      );
      if (!Array.isArray(rows)) return [];
      const out: { health: string; body: string; createdAt: string }[] = [];
      for (const entry of rows) {
        const row = record(entry);
        const at = row?.['createdAt'];
        const date =
          at instanceof Date
            ? at
            : typeof at === 'string'
              ? new Date(at)
              : null;
        if (!row || !date || Number.isNaN(date.getTime())) continue;
        out.push({
          health: isHealth(row['health']) ? row['health'] : 'on_track',
          body: typeof row['body'] === 'string' ? row['body'] : '',
          createdAt: date.toISOString(),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private eventSummary(event: DomainEventEntity): string {
    const data = record(event.data);
    const label = [data?.['key'], data?.['title'], data?.['name']].find(
      (v): v is string => typeof v === 'string' && !!v,
    );
    return clip(label ?? `${event.subject.type} ${event.subject.id}`, 160);
  }
}
