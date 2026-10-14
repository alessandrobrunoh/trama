import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  INSIGHT_SIGNALS,
  type InsightBottleneck,
  type InsightContributor,
  type InsightItem,
  type InsightSignal,
  type InsightSignalId,
  type InsightWipRow,
  type InsightsReport,
} from '../contracts/domain.js';
import { projectHidden } from '../auth/member-access.js';

type Query = { days?: number; teamId?: string; projectId?: string; staleDays?: number; limit?: number };
type Row = Record<string, any>;
const DAY = 86_400_000;
const OPEN = ['backlog', 'todo', 'in_progress', 'in_review'];
const ACTIVE = ['in_progress', 'in_review'];

function age(date: Date, now: Date): number {
  return Math.max(0, Math.round(((now.getTime() - date.getTime()) / DAY) * 10) / 10);
}

function duration(from: Date, to: Date): number {
  return Math.max(0, Math.round(((to.getTime() - from.getTime()) / DAY) * 10) / 10);
}

function stats(values: number[]) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    count: values.length,
    p50: percentile(0.5),
    p85: percentile(0.85),
    p95: percentile(0.95),
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
    max: sorted[sorted.length - 1],
  };
}

@Injectable()
export class InsightsService {
  constructor(private readonly db: DataSource) {}

  async report(ctx: WorkspaceContext, query: Query): Promise<InsightsReport> {
    const data = await this.load(ctx, query);
    return data.report;
  }

  async signal(ctx: WorkspaceContext, id: InsightSignalId, query: Query): Promise<InsightSignal> {
    return (await this.load(ctx, query)).report.signals.find((signal) => signal.id === id)!;
  }

  private async load(ctx: WorkspaceContext, query: Query) {
    const workspaceId = ctx.workspace.id;
    const days = query.days ?? 30;
    const staleDays = query.staleDays ?? 7;
    const limit = query.limit ?? 25;
    const now = new Date();
    const from = new Date(now.getTime() - days * DAY);
    const lookback = new Date(now.getTime() - Math.max(days * 2, 90) * DAY);
    if (query.teamId) {
      const [team] = await this.db.query<Row[]>(
        'SELECT id FROM teams WHERE id = $1 AND "workspaceId" = $2',
        [query.teamId, workspaceId],
      );
      if (!team) throw new NotFoundException('Team not found');
    }
    if (query.projectId) {
      const [project] = await this.db.query<Row[]>(
        'SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2',
        [query.projectId, workspaceId],
      );
      if (!project || projectHidden(ctx.access, query.projectId)) throw new NotFoundException('Project not found');
    }

    const conditions = ['i."workspaceId" = $1'];
    const params: unknown[] = [workspaceId];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.teamId) conditions.push(`i."teamId" = ${bind(query.teamId)}`);
    if (query.projectId) conditions.push(`i."projectId" = ${bind(query.projectId)}`);
    // Keep this as a correlated scope: all report data derives from visible Issues.
    const issues: Row[] = await this.db.query(
      `SELECT i.id, i.key, i.title, i.status, i."teamId", i."projectId", i."assigneeId",
              i."createdAt", i."updatedAt", i."startedAt", i."completedAt", i."milestoneIds"
         FROM issues i WHERE ${conditions.join(' AND ')}
           AND (i.status IN ('backlog','todo','in_progress','in_review') OR i."completedAt" >= $${params.push(lookback)})`,
      params,
    );
    const visibleIssues = issues.filter((issue) => !projectHidden(ctx.access, issue.projectId));
    const issueIds = visibleIssues.map((issue) => issue.id);
    const scoped = issueIds.length > 0;
    const requests: Row[] = scoped
      ? await this.db.query(
          `SELECT r.question, r."assigneeUserId", r."createdAt", r."issueId",
                  i.id, i.key, i.title
             FROM input_requests r JOIN issues i ON i.id = r."issueId" AND i."workspaceId" = r."workspaceId"
            WHERE r."workspaceId" = $1 AND r.state = 'open'
               AND r."issueId" = ANY($2::text[])`,
          [workspaceId, issueIds],
        )
      : [];
    const decisions: Row[] = scoped
      ? await this.db.query(
          `SELECT DISTINCT d.id, d.key, d.title, d."createdAt", d."proposedBy"
             FROM decisions d JOIN issues i ON i."workspaceId" = d."workspaceId"
               AND (i.id = d."originIssueId" OR d."relatedIssueIds" ? i.id)
            WHERE d."workspaceId" = $1 AND d.status = 'proposed' AND i.id = ANY($2::text[])`,
          [workspaceId, issueIds],
        )
      : [];
    const artifacts: Row[] = scoped
      ? await this.db.query(
          `SELECT a.id, a.title, a.kind, a.state, a.ci, a.review, a."updatedAt", a."issueId",
                  i.key AS "issueKey"
             FROM artifacts a JOIN issues i ON i.id = a."issueId" AND i."workspaceId" = a."workspaceId"
            WHERE a."workspaceId" = $1 AND a."issueId" = ANY($2::text[])
              AND a.kind IN ('pull_request', 'merge_request') AND a.state = 'open'`,
          [workspaceId, issueIds],
        )
      : [];
    const milestones: Row[] = await this.db.query(
      `SELECT m.id, m.name, m."projectId", m."targetDate", p.name AS "projectName", p.status AS "projectStatus",
              count(i.id) FILTER (WHERE i.status = ANY($2::text[]))::int AS "openIssues"
         FROM milestones m JOIN projects p ON p.id = m."projectId"
         LEFT JOIN issues i ON i."workspaceId" = m."workspaceId" AND i."milestoneIds" ? m.id
        WHERE m."workspaceId" = $1 AND m."targetDate" < now()
          AND ($3::text IS NULL OR m."projectId" = $3)
        GROUP BY m.id, p.id`,
      [workspaceId, OPEN, query.projectId ?? null],
    );
    const visibleMilestones = milestones.filter((m) =>
      visibleIssues.some((i) => i.projectId === m.projectId),
    );
    const events: Row[] = scoped
      ? await this.db.query(
          `SELECT e.actor->>'id' AS "actorId", e.actor->>'type' AS "actorType", e.type,
                  max(e.at) AS "lastAt", count(*)::int AS events
             FROM domain_events e
            WHERE e."workspaceId" = $1 AND e.at >= $2 AND e.at < $3
              AND e.subject->>'id' = ANY($4::text[])
              AND e.actor->>'type' IN ('user', 'agent')
            GROUP BY 1, 2, 3`,
          [workspaceId, from, now, issueIds],
        )
      : [];
    const actorNames: Row[] = events.length
      ? await this.db.query(
          `SELECT id, name, 'user' AS type FROM users WHERE id = ANY($1::text[])
           UNION ALL SELECT id, name, 'agent' AS type FROM agents WHERE id = ANY($2::text[])`,
          [
            [...new Set(events.filter((e) => e.actorType === 'user').map((e) => e.actorId))],
            [...new Set(events.filter((e) => e.actorType === 'agent').map((e) => e.actorId))],
          ],
        )
      : [];

    const item = (
      type: InsightItem['type'],
      row: Row,
      since: Date,
      detail: string,
      waitingOn?: InsightItem['waitingOn'],
    ): InsightItem => ({
      type,
      id: row.id,
      ...(row.key ? { key: row.key } : {}),
      title: row.title ?? row.name,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      since: since.toISOString(),
      ageDays: age(since, now),
      ...(waitingOn ? { waitingOn } : {}),
      detail,
    });
    const signalItems: Record<InsightSignalId, InsightItem[]> = {
      needs_input: [
        ...requests.map((r) => item(
          'issue',
          r,
          r.createdAt,
          'Issue question is waiting for an answer.',
          r.assigneeUserId ? { type: 'user', id: r.assigneeUserId, name: r.assigneeUserId } : { type: 'unassigned', name: 'Unassigned' },
        )),
        ...decisions.map((d) => item('decision', d, d.createdAt, 'Proposed Decision is waiting for a response.')),
      ],
      stale_issues: visibleIssues
        .filter((i) => ACTIVE.includes(i.status) && age(new Date(i.updatedAt), now) >= staleDays)
        .map((i) => item('issue', i, new Date(i.updatedAt), 'In-flight Issue has not been updated recently.')),
      overdue_milestones: visibleMilestones
        .filter((m) => Number(m.openIssues) > 0 && !['completed', 'canceled'].includes(m.projectStatus))
        .map((m) => ({ ...item('milestone', m, new Date(m.targetDate), `${m.openIssues} open Issues remain.`), projectId: m.projectId })),
      prs_stuck_in_review: artifacts
        .filter((a) => a.review?.approved !== true && a.review?.state !== 'approved' && age(new Date(a.updatedAt), now) >= 3)
        .map((a) => item('artifact', a, new Date(a.updatedAt), 'Open pull request has no approval and has been inactive for at least 3 days.')),
      ci_failing: artifacts
        .filter((a) => a.ci === 'failing' || a.ci?.state === 'failing' || a.ci?.status === 'failing')
        .map((a) => item('artifact', a, new Date(a.updatedAt), 'Latest pull request CI result is failing.')),
      undecided_decisions: decisions.map((d) => item('decision', d, d.createdAt, 'Proposed Decision is waiting for a response.')),
      customer_demand_waiting: [],
    };
    const signals = (Object.keys(INSIGHT_SIGNALS) as InsightSignalId[]).map((id) => {
      const all = signalItems[id].sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
      const oldestDays = all[0]?.ageDays;
      return {
        id, ...INSIGHT_SIGNALS[id], severity: all.length ? (id === 'overdue_milestones' || id === 'stale_issues' ? 'warning' : 'info') : 'ok',
        count: all.length, ...(oldestDays === undefined ? {} : { oldestDays }), items: all.slice(0, limit), truncated: all.length > limit,
      } as InsightSignal;
    });
    const done = visibleIssues.filter((i) => i.status === 'done' && i.completedAt && new Date(i.completedAt) >= from);
    const cycle = done.filter((i) => i.startedAt).map((i) => duration(new Date(i.startedAt), new Date(i.completedAt)));
    const lead = done.map((i) => duration(new Date(i.createdAt), new Date(i.completedAt)));
    const throughput = Array.from({ length: Math.ceil(days / 7) }, (_, n) => {
      const start = new Date(from.getTime() + n * 7 * DAY);
      const end = new Date(Math.min(start.getTime() + 7 * DAY, now.getTime()));
      return { start: start.toISOString(), end: end.toISOString(), issuesDone: done.filter((i) => new Date(i.completedAt) >= start && new Date(i.completedAt) < end).length };
    });
    const contributors = new Map<string, InsightContributor>();
    for (const event of events) {
      const key = `${event.actorType}:${event.actorId}`;
      const actor = contributors.get(key) ?? {
        actor: {
          type: event.actorType,
          id: event.actorId,
          name: actorNames.find((candidate) => candidate.id === event.actorId)?.name ?? 'Unknown',
        },
        events: 0,
        issuesDone: 0,
        comments: 0,
        pullRequests: 0,
        decisionsProposed: 0,
        inputRequestsRaised: 0,
        lastActiveAt: new Date(event.lastAt).toISOString(),
      };
      actor.events += Number(event.events);
      if (event.type === 'issue.status_changed') actor.issuesDone += Number(event.events);
      actor.lastActiveAt = new Date(
        Math.max(
          new Date(actor.lastActiveAt ?? event.lastAt).getTime(),
          new Date(event.lastAt).getTime(),
        ),
      ).toISOString();
      contributors.set(key, actor);
    }
    const contributorRows = [...contributors.values()].sort((a, b) => b.events - a.events);
    const eventTotal = contributorRows.reduce((sum, row) => sum + row.events, 0);
    const peopleEvents = contributorRows.filter((row) => row.actor.type === 'user').reduce((sum, row) => sum + row.events, 0);
    const wipByAssignee = new Map<string, Row[]>();
    for (const issue of visibleIssues.filter((row) => ACTIVE.includes(row.status) && row.assigneeId)) {
      const assigned = wipByAssignee.get(issue.assigneeId) ?? [];
      assigned.push(issue);
      wipByAssignee.set(issue.assigneeId, assigned);
    }
    const wipUsers = wipByAssignee.size
      ? await this.db.query<Row[]>(
          'SELECT id, name FROM users WHERE id = ANY($1::text[])',
          [[...wipByAssignee.keys()]],
        )
      : [];
    const wipRows: InsightWipRow[] = [...wipByAssignee].map(([id, assigned]) => ({
      actor: { type: 'user' as const, id, name: wipUsers.find((user) => user.id === id)?.name ?? 'Unknown' },
      issues: assigned.length,
      overloaded: assigned.length > 5,
      items: assigned.map((issue) => item('issue', issue, new Date(issue.updatedAt), 'Assigned in-flight Issue.')),
    })).sort((a, b) => b.issues - a.issues);
    const bottleneckMap = new Map<string, InsightBottleneck>();
    for (const waiting of signalItems.needs_input) {
      const actor = waiting.waitingOn ?? { type: 'unassigned' as const, name: 'Unassigned' };
      const key = actor.id ?? 'unassigned';
      const row = bottleneckMap.get(key) ?? {
        actor,
        inputRequests: 0,
        decisions: 0,
        reviews: 0,
        oldestDays: 0,
        totalWaitDays: 0,
      };
      if (waiting.type === 'decision') row.decisions++;
      else row.inputRequests++;
      row.oldestDays = Math.max(row.oldestDays, waiting.ageDays ?? 0);
      row.totalWaitDays += waiting.ageDays ?? 0;
      bottleneckMap.set(key, row);
    }
    const report: InsightsReport = {
      generatedAt: now.toISOString(), range: { days, from: from.toISOString(), to: now.toISOString() },
      scope: { ...(query.teamId ? { teamId: query.teamId } : {}), ...(query.projectId ? { projectId: query.projectId } : {}) },
      staleDays, signals,
      bottlenecks: [...bottleneckMap.values()].sort((a, b) => b.totalWaitDays - a.totalWaitDays),
      flow: {
        issueCycle: { stats: stats(cycle), histogram: [], slowest: [] },
        issueLead: { stats: stats(lead), histogram: [], slowest: [] },
        throughput, previousThroughput: { issuesDone: 0 },
        wip: { people: wipRows, agents: [], limits: { issues: 5 } },
        aging: { baselineSamples: 0, items: [] },
      },
      actors: {
        people: contributorRows.filter((row) => row.actor.type === 'user'),
        agents: contributorRows.filter((row) => row.actor.type === 'agent'),
        share: { people: eventTotal ? peopleEvents / eventTotal : 0, agents: eventTotal ? (eventTotal - peopleEvents) / eventTotal : 0 },
        failures: [],
      },
    };
    return { report, signalItems };
  }
}
