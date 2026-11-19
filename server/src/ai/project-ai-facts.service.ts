import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, type Repository } from 'typeorm';
import {
  DomainEventEntity,
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

/** Reads everything the project AI needs straight from the repositories. Read-only. */
@Injectable()
export class ProjectAiFactsService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(MilestoneEntity)
    private readonly milestones: Repository<MilestoneEntity>,
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
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
    const [events, candidates] = await Promise.all([
      this.recentEvents(workspaceId, project.id, issueIds),
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

    return {
      project: {
        id: project.id,
        name: project.name,
        summary: project.summary,
        description: project.description,
        status: project.status,
        priority: project.priority,
        lead: project.leadId ? (names.get(project.leadId) ?? null) : null,
        startDate: iso(project.startDate),
        targetDate: iso(project.targetDate),
        createdAt: project.createdAt.toISOString(),
      },
      milestones: milestones.map((m) => ({
        id: m.id,
        name: m.name,
        targetDate: iso(m.targetDate),
      })),
      issues: issues.map(toIssue),
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

  private eventSummary(event: DomainEventEntity): string {
    const data = record(event.data);
    const label = [data?.['key'], data?.['title'], data?.['name']].find(
      (v): v is string => typeof v === 'string' && !!v,
    );
    return clip(label ?? `${event.subject.type} ${event.subject.id}`, 160);
  }
}
