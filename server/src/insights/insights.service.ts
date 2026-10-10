import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { InsightSignal, InsightSignalId, InsightsReport } from '../contracts/domain.js';
import { computeActors, type ActorArtifact, type ActorInputRequest, type EventCountRow } from './insights-actors.js';
import { buildFacts, type ActivityRow, type StatusEventRow } from './insights-facts.js';
import {
  BASELINE_DAYS,
  AGENT_TOUCH_DAYS,
  computeAging,
  computeCumulativeFlow,
  computeDurations,
  computeThroughput,
  computeWip,
  type AgentTouch,
  type IssueChange,
} from './insights-flow.js';
import {
  buildSignals,
  computeBottlenecks,
  computeSignalItems,
  type IArtifact,
  type ICustomerRequest,
  type IDecision,
  type IDependency,
  type IInputRequest,
  type IIssue,
  type IIssueLink,
  type IMilestone,
  type IShippedWorkstream,
  type IWorkstream,
  type SignalData,
} from './insights-signals.js';
import { DAY, type NameIndex } from './insights-util.js';

export interface InsightsQuery {
  days: number;
  teamId?: string;
  projectId?: string;
  staleDays: number;
  /** Items kept per signal (counts are never cut). */
  limit: number;
}

export const DEFAULT_QUERY: InsightsQuery = { days: 30, staleDays: 7, limit: 25 };

type Row = Record<string, any>;
const OPEN_ISSUE = `('backlog','todo','in_progress','in_review')`;
const PR_KINDS = `('pull_request','merge_request')`;

/** SQL that appends numbered parameters and remembers them. */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

@Injectable()
export class InsightsService {
  constructor(private readonly ds: DataSource) {}

  async report(ctx: WorkspaceContext, q: InsightsQuery): Promise<InsightsReport> {
    const data = await this.load(ctx.workspace.id, q);
    const items = computeSignalItems(data.signals);
    const workstreamRows = data.signals.workstreams;
    const window = { from: data.from, to: data.to };
    const durations = computeDurations(data.signals.issues, workstreamRows, window);
    const throughput = computeThroughput(data.signals.issues, workstreamRows, window);
    return {
      generatedAt: data.to.toISOString(),
      range: { days: q.days, from: data.from.toISOString(), to: data.to.toISOString() },
      scope: { ...(q.teamId ? { teamId: q.teamId } : {}), ...(q.projectId ? { projectId: q.projectId } : {}) },
      staleDays: q.staleDays,
      signals: buildSignals(items, q.staleDays, q.limit),
      bottlenecks: computeBottlenecks(items),
      flow: {
        ...durations,
        throughput: throughput.buckets,
        previousThroughput: throughput.previous,
        wip: computeWip(data.signals.issues, workstreamRows, data.touches, data.signals.names, data.to),
        aging: computeAging(data.signals.issues, data.to, data.signals.names),
        cumulativeFlow: computeCumulativeFlow(data.signals.issues, data.changes, data.doneBefore, window),
      },
      actors: computeActors({
        names: data.signals.names,
        agentIds: data.agentIds,
        rangeFrom: data.from,
        events: data.events,
        artifacts: data.actorArtifacts,
        inputRequests: data.actorRequests,
        reopenedByAgent: data.reopened,
      }),
    };
  }

  /** The complete list behind one signal tile (up to `limit` items). */
  async signal(ctx: WorkspaceContext, id: InsightSignalId, q: InsightsQuery): Promise<InsightSignal> {
    const data = await this.load(ctx.workspace.id, q);
    const signal = buildSignals(computeSignalItems(data.signals), q.staleDays, q.limit).find((s) => s.id === id);
    if (!signal) throw new NotFoundException(`Unknown signal "${id}"`);
    return signal;
  }

  private async load(workspaceId: string, q: InsightsQuery) {
    const db = this.ds;
    const now = new Date();
    const from = new Date(now.getTime() - q.days * DAY);
    const lookback = new Date(now.getTime() - Math.max(q.days * 2, BASELINE_DAYS) * DAY);
    const scoped = !!(q.teamId || q.projectId);

    if (q.teamId) {
      const [t] = await db.query<Row[]>(`SELECT 1 FROM teams WHERE id = $1 AND "workspaceId" = $2`, [q.teamId, workspaceId]);
      if (!t) throw new NotFoundException('Team not found');
    }
    if (q.projectId) {
      const [p] = await db.query<Row[]>(`SELECT 1 FROM projects WHERE id = $1 AND "workspaceId" = $2`, [q.projectId, workspaceId]);
      if (!p) throw new NotFoundException('Project not found');
    }

    // workstreams in scope: open ones, plus those shipped inside the look-back window
    const wp = new Params();
    const wsWhere = [
      `"workspaceId" = ${wp.add(workspaceId)}`,
      `status <> 'draft'`,
      `(status NOT IN ('shipped','canceled') OR "shippedAt" >= ${wp.add(lookback)})`,
    ];
    if (q.teamId) {
      const t = wp.add(q.teamId);
      wsWhere.push(`("ownerTeamId" = ${t} OR "participatingTeamIds" ? ${t}::text)`);
    }
    if (q.projectId) wsWhere.push(`"projectId" = ${wp.add(q.projectId)}`);
    const workstreams = (
      await db.query<Row[]>(
        `SELECT id, key, title, status, delivery, "ownerTeamId", "accountableUserId", "projectId", "startDate", "targetDate",
                "createdAt", "updatedAt", "shippedAt", "acceptanceCriteria"
           FROM workstreams WHERE ${wsWhere.join(' AND ')}`,
        wp.values,
      )
    ).map((r): IWorkstream => ({ ...(r as IWorkstream) }));
    // every shipped workstream in scope, whenever it shipped: the historic proof check is not windowed
    const sp = new Params();
    const shippedWhere = [`"workspaceId" = ${sp.add(workspaceId)}`, `status = 'shipped'`];
    if (q.teamId) {
      const t = sp.add(q.teamId);
      shippedWhere.push(`("ownerTeamId" = ${t} OR "participatingTeamIds" ? ${t}::text)`);
    }
    if (q.projectId) shippedWhere.push(`"projectId" = ${sp.add(q.projectId)}`);
    const shippedHistory = (
      await db.query<Row[]>(
        `SELECT id, key, title, status, "derivedStatus", "statusOverride", "legacyShipped", "accountableUserId", "shippedAt", "updatedAt",
                "acceptanceCriteria"
           FROM workstreams WHERE ${shippedWhere.join(' AND ')}`,
        sp.values,
      )
    ).map((r): IShippedWorkstream => ({ ...(r as IShippedWorkstream) }));
    const wsIds = workstreams.map((w) => w.id);
    const openWsIds = workstreams.filter((w) => w.status !== 'shipped' && w.status !== 'canceled').map((w) => w.id);

    // issues: open ones, plus those finished inside the look-back window
    const ip = new Params();
    const issueWhere = [`"workspaceId" = ${ip.add(workspaceId)}`];
    const issueScope: string[] = [];
    if (q.teamId) issueScope.push(`("teamId" = ${ip.add(q.teamId)} OR "workstreamIds" ?| ${ip.add(wsIds)}::text[])`);
    if (q.projectId) issueScope.push(`("projectId" = ${ip.add(q.projectId)} OR "workstreamIds" ?| ${ip.add(wsIds)}::text[])`);
    const issueCols = `id, key, title, kind, status, "assigneeId", "teamId", "projectId", "workstreamIds", "milestoneIds",
                "createdAt", "startedAt", "completedAt", "updatedAt"`;
    const windowParam = ip.add(lookback);
    const issues = (
      await db.query<Row[]>(
        `SELECT ${issueCols} FROM issues
          WHERE ${[...issueWhere, ...issueScope].join(' AND ')}
            AND (status IN ${OPEN_ISSUE} OR "completedAt" >= ${windowParam})`,
        ip.values,
      )
    ).map((r) => r as IIssue);
    const [{ n: doneBefore }] = await db.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM issues
        WHERE ${[...issueWhere, ...issueScope].join(' AND ')}
          AND status = 'done' AND ("completedAt" IS NULL OR "completedAt" < ${windowParam})`,
      ip.values,
    );

    const wsFilter = (col: string, p: Params): string => (scoped ? ` AND ${col} = ANY(${p.add(wsIds)}::text[])` : '');

    const issueIds = issues.map((i) => i.id);
    const run = (build: (p: Params) => string) => {
      const p = new Params();
      const sql = build(p);
      return db.query<Row[]>(sql, p.values);
    };
    const [
      statusRows, activityRows, changeRows, linkRows, inputRows, artifactRows, ciRows, decisionRows, depRows,
      milestoneRows, customerRows, userRows, agentRows, eventRows, touchRows, reopenedRows, actorArtifactRows, actorRequestRows,
    ] = await Promise.all([
      run((p) => `SELECT "workstreamId" AS id, data->>'to' AS "to", min(at) AS "firstAt", max(at) AS "lastAt" FROM domain_events
          WHERE "workspaceId" = ${p.add(workspaceId)} AND type = 'workstream.status_changed' AND "workstreamId" = ANY(${p.add(wsIds)}::text[]) GROUP BY 1, 2`),
      run((p) => `SELECT "workstreamId" AS id, max(at) AS "lastAt" FROM domain_events
          WHERE "workspaceId" = ${p.add(workspaceId)} AND "workstreamId" = ANY(${p.add(wsIds)}::text[]) AND actor->>'type' <> 'system' GROUP BY 1`),
      run((p) => `SELECT subject->>'id' AS "issueId", at, data->>'from' AS "from", data->>'to' AS "to" FROM domain_events
          WHERE "workspaceId" = ${p.add(workspaceId)} AND type = 'issue.status_changed' AND subject->>'id' = ANY(${p.add(issueIds)}::text[]) ORDER BY at`),
      run((p) => `SELECT subject->>'id' AS "issueId", "workstreamId", min(at) AS at FROM domain_events
          WHERE "workspaceId" = ${p.add(workspaceId)} AND type = 'issue.linked' AND "workstreamId" = ANY(${p.add(openWsIds)}::text[]) GROUP BY 1, 2`),
      (() => {
        const p = new Params();
        return db.query<Row[]>(
          `SELECT id, "workstreamId", question, "requestedBy", "assigneeUserId", "createdAt" FROM input_requests
            WHERE "workspaceId" = ${p.add(workspaceId)} AND state = 'open'${wsFilter('"workstreamId"', p)}`,
          p.values,
        );
      })(),
      (() => {
        const p = new Params();
        return db.query<Row[]>(
          `SELECT id, "workstreamId", kind, title, "externalId", state, ci, review, "hasConflicts", "authorRef", "createdAt", "updatedAt"
             FROM artifacts
            WHERE "workspaceId" = ${p.add(workspaceId)} AND kind IN ('pull_request','merge_request','release','deployment')
              AND (state IN ('open','draft') OR "updatedAt" >= ${p.add(lookback)} OR "workstreamId" = ANY(${p.add(openWsIds)}::text[]))
              ${wsFilter('"workstreamId"', p)}`,
          p.values,
        );
      })(),
      db.query<Row[]>(
        `SELECT subject->>'id' AS id, max(at) AS at FROM domain_events
          WHERE "workspaceId" = $1 AND type = 'artifact.updated' AND data->'changes'->'ci'->>1 = 'failing' GROUP BY 1`,
        [workspaceId],
      ),
      (() => {
        const p = new Params();
        const scope = scoped
          ? ` AND ("originWorkstreamId" = ANY(${p.add(wsIds)}::text[]) OR "relatedWorkstreamIds" ?| ${p.add(wsIds)}::text[])`
          : '';
        return db.query<Row[]>(
          `SELECT id, key, title, status, "originWorkstreamId", "relatedWorkstreamIds", "proposedBy", "createdAt" FROM decisions
            WHERE "workspaceId" = ${p.add(workspaceId)} AND status = 'proposed'${scope}`,
          p.values,
        );
      })(),
      db.query<Row[]>(`SELECT "fromId", "toId" FROM dependencies WHERE "workspaceId" = $1 AND "fromType" = 'workstream' AND "toType" = 'workstream'`, [workspaceId]),
      (() => {
        const p = new Params();
        const scope = [q.projectId ? `m."projectId" = ${p.add(q.projectId)}` : '', q.teamId ? `p."teamIds" ? ${p.add(q.teamId)}::text` : '']
          .filter(Boolean)
          .map((c) => ` AND ${c}`)
          .join('');
        return db.query<Row[]>(
          `SELECT m.id, m.name, m."projectId", p.name AS "projectName", p.status AS "projectStatus", m."targetDate",
                  count(i.id) FILTER (WHERE i.status IN ${OPEN_ISSUE})::int AS "openIssues",
                  count(i.id) FILTER (WHERE i.status = 'done')::int AS "doneIssues"
             FROM milestones m
             JOIN projects p ON p.id = m."projectId"
             LEFT JOIN issues i ON i."workspaceId" = m."workspaceId" AND i."milestoneIds" ? m.id
            WHERE m."workspaceId" = ${p.add(workspaceId)} AND m."targetDate" IS NOT NULL AND m."targetDate" < now()${scope}
            GROUP BY m.id, p.id`,
          p.values,
        );
      })(),
      (() => {
        const p = new Params();
        const scope = [
          q.teamId ? `(i."teamId" = ${p.add(q.teamId)} OR p."teamIds" ? ${p.add(q.teamId)}::text)` : '',
          q.projectId ? `(i."projectId" = ${p.add(q.projectId)} OR cr."projectId" = ${p.add(q.projectId)})` : '',
        ]
          .filter(Boolean)
          .map((c) => ` AND ${c}`)
          .join('');
        return db.query<Row[]>(
          `SELECT cr."issueId", cr."projectId", cr."createdAt", cr.important, c.name AS "customerName",
                  i.key AS "issueKey", i.title AS "issueTitle", p.name AS "projectName"
             FROM customer_requests cr
             JOIN customers c ON c.id = cr."customerId" AND c.status <> 'churned' AND c."archivedAt" IS NULL
             LEFT JOIN issues i ON i.id = cr."issueId"
             LEFT JOIN projects p ON p.id = cr."projectId"
            WHERE cr."workspaceId" = ${p.add(workspaceId)}
              AND ((i.id IS NOT NULL AND i.status NOT IN ('done','canceled')) OR (p.id IS NOT NULL AND p.status NOT IN ('completed','canceled')))${scope}`,
          p.values,
        );
      })(),
      db.query<Row[]>(`SELECT u.id, u.name FROM users u JOIN memberships m ON m."userId" = u.id WHERE m."workspaceId" = $1`, [workspaceId]),
      db.query<Row[]>(`SELECT id, name FROM agents WHERE "workspaceId" = $1`, [workspaceId]),
      (() => {
        const p = new Params();
        return db.query<Row[]>(
          `SELECT actor->>'type' AS "actorType", actor->>'id' AS "actorId", type,
                  CASE WHEN type = 'issue.status_changed' THEN data->>'to' END AS "to", count(*)::int AS n, max(at) AS "lastAt"
             FROM domain_events
            WHERE "workspaceId" = ${p.add(workspaceId)} AND at >= ${p.add(from)} AND at < ${p.add(now)}
              AND actor->>'type' IN ('user','agent')${wsFilter('"workstreamId"', p)}
            GROUP BY 1, 2, 3, 4`,
          p.values,
        );
      })(),
      (() => {
        const p = new Params();
        return db.query<Row[]>(
          `SELECT DISTINCT actor->>'id' AS "agentId", "workstreamId" FROM domain_events
            WHERE "workspaceId" = ${p.add(workspaceId)} AND at >= ${p.add(new Date(now.getTime() - AGENT_TOUCH_DAYS * DAY))}
              AND actor->>'type' = 'agent' AND "workstreamId" IS NOT NULL${wsFilter('"workstreamId"', p)}`,
          p.values,
        );
      })(),
      db.query<Row[]>(
        `SELECT d.actor->>'id' AS "agentId", count(DISTINCT d.subject->>'id')::int AS n
           FROM domain_events d
           JOIN domain_events r ON r."workspaceId" = d."workspaceId" AND r.type = 'issue.status_changed'
            AND r.subject->>'id' = d.subject->>'id' AND r.data->>'from' = 'done' AND r.data->>'to' NOT IN ('done','canceled')
            AND r.at > d.at AND r.at >= $2 AND r.at < $3
          WHERE d."workspaceId" = $1 AND d.type = 'issue.status_changed' AND d.data->>'to' = 'done' AND d.actor->>'type' = 'agent'
            AND d.at >= $2::timestamptz - interval '90 days'
            AND NOT EXISTS (
              SELECT 1 FROM domain_events d2 WHERE d2."workspaceId" = d."workspaceId" AND d2.type = 'issue.status_changed'
                AND d2.subject->>'id' = d.subject->>'id' AND d2.data->>'to' = 'done' AND d2.at > d.at AND d2.at < r.at)
          GROUP BY 1`,
        [workspaceId, from, now],
      ),
      (() => {
        const p = new Params();
        return db.query<Row[]>(
          `SELECT kind, state, ci, "authorRef", "createdAt" FROM artifacts
            WHERE "workspaceId" = ${p.add(workspaceId)} AND kind IN ${PR_KINDS} AND "authorRef"->>'type' IN ('user','agent')
              AND ("createdAt" >= ${p.add(from)} OR state = 'open')${wsFilter('"workstreamId"', p)}`,
          p.values,
        );
      })(),
      (() => {
        const p = new Params();
        return db.query<Row[]>(
          `SELECT "requestedBy", state, "createdAt", "answeredAt" FROM input_requests
            WHERE "workspaceId" = ${p.add(workspaceId)} AND "requestedBy"->>'type' = 'agent'
              AND ("createdAt" >= ${p.add(from)} OR state = 'open')${wsFilter('"workstreamId"', p)}`,
          p.values,
        );
      })(),
    ]);

    const names: NameIndex = new Map<string, { name: string; type: 'user' | 'agent' }>([
      ...userRows.map((u) => [u.id as string, { name: u.name as string, type: 'user' as const }] as const),
      ...agentRows.map((a) => [a.id as string, { name: a.name as string, type: 'agent' as const }] as const),
    ]);
    const ciFailedAt = new Map(ciRows.map((r) => [r.id as string, r.at as Date]));
    const artifacts = artifactRows.map((r): IArtifact => ({ ...(r as IArtifact), ciFailedAt: ciFailedAt.get(r.id) }));

    const signals: SignalData = {
      now,
      rangeFrom: from,
      staleDays: q.staleDays,
      names,
      workstreams,
      shippedHistory,
      facts: buildFacts(
        workstreams,
        statusRows as StatusEventRow[],
        activityRows as ActivityRow[],
      ),
      issues,
      inputRequests: inputRows.map((r) => r as IInputRequest),
      artifacts,
      decisions: decisionRows.map((r) => r as IDecision),
      dependencies: depRows.map((r) => r as IDependency),
      milestones: milestoneRows.map((r) => r as IMilestone),
      issueLinks: linkRows.map((r) => r as IIssueLink),
      customerRequests: customerRows.map((r): ICustomerRequest => ({
        customerName: r.customerName,
        important: !!r.important,
        createdAt: r.createdAt,
        targetType: r.issueId ? 'issue' : 'project',
        targetId: r.issueId ?? r.projectId,
        targetKey: r.issueKey ?? undefined,
        targetTitle: r.issueTitle ?? r.projectName ?? 'Project',
      })),
    };

    return {
      from,
      to: now,
      signals,
      doneBefore: Number(doneBefore),
      changes: changeRows.map((r): IssueChange => ({ issueId: r.issueId, at: r.at, from: r.from, to: r.to })),
      touches: touchRows.map((r): AgentTouch => ({ agentId: r.agentId, workstreamId: r.workstreamId })),
      agentIds: agentRows.map((a) => a.id as string),
      events: eventRows.map((r) => r as EventCountRow),
      reopened: new Map(reopenedRows.map((r) => [r.agentId as string, r.n as number])),
      actorArtifacts: actorArtifactRows.map((r) => r as ActorArtifact),
      actorRequests: actorRequestRows.map((r) => r as ActorInputRequest),
    };
  }
}
