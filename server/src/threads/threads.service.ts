import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { applyProjectScope, currentAccess } from '../auth/member-access.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { notFound, uid } from '../common/util.js';
import {
  THREAD_FILES_MAX,
  statusIdsForTypes,
  type ActorRef,
  type EstimateSuggestion,
  type ThreadDecision,
  type ThreadRecord,
  type ThreadSyncInput,
  type ThreadSyncResult,
} from '../contracts/domain.js';
import { IssueEntity, type ArtifactEntity, type WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { IssuesService } from '../issues/issues.service.js';
import { assertThreadLinkable } from '../issues/thread-link.js';
import { loadStatusCatalog } from '../status/status-catalog.js';
import { TimeEntryEntity } from '../time-entries/time-entry.entity.js';
import {
  buildEstimateSuggestion,
  rankSimilar,
  type FinishedTask,
} from './estimate-suggestion.js';
import { parsePullRequestUrl } from './pull-request-url.js';
import { cleanThreadPaths, decisionMatchesPath, mergeFiles } from './thread-paths.js';
import { TaskDecisionEntity, ThreadRecordEntity } from './thread.entity.js';

export const DECISIONS_DEFAULT_LIMIT = 50;
export const DECISIONS_MAX_LIMIT = 200;
/** Most decisions looked at when a path filter has to be applied in memory (newest first). */
const DECISIONS_SCAN_MAX = 5000;
/** Most finished tasks compared for an estimate suggestion (finished most recently first). */
const ESTIMATE_CANDIDATES_MAX = 500;

/** Who the sync is for and what the caller may do besides editing the task. */
export interface SyncCaller {
  actor: ActorRef;
  /** The person the key acts as. Absent for agent tokens. */
  userId?: string;
  /** May the caller attach artifacts (custom tokens need `artifacts:write`)? */
  canWriteArtifacts: boolean;
}

export type ThreadSyncResponse = Omit<ThreadSyncResult, 'artifact'> & {
  artifact: ArtifactEntity | null;
};

interface CleanSync {
  threadUrl?: string;
  summary?: string | null;
  decisions: { text: string; paths: string[] }[];
  files: string[];
  pullRequestUrl?: string;
  activeMinutes?: number;
  turns?: number;
}

/** Trims and checks everything a sync sends, so nothing is written when part of it is wrong. */
export function cleanSyncInput(input: ThreadSyncInput): CleanSync {
  const decisions = (input.decisions ?? []).map((d) => {
    const text = d.text.trim();
    if (!text) throw new BadRequestException('A decision needs text');
    return { text, paths: cleanThreadPaths(d.paths ?? []) };
  });
  return {
    threadUrl: input.threadUrl,
    summary: input.summary === undefined ? undefined : input.summary.trim() || null,
    decisions,
    files: cleanThreadPaths(input.files ?? []),
    pullRequestUrl: input.pullRequestUrl,
    activeMinutes: input.activeMinutes,
    turns: input.turns,
  };
}

const toDecision = (row: TaskDecisionEntity, issueKey: string): ThreadDecision => ({
  id: row.id,
  issueId: row.issueId,
  issueKey,
  text: row.text,
  paths: row.paths,
  threadUrl: row.threadUrl,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const toRecord = (
  row: ThreadRecordEntity,
  decisions: ThreadDecision[],
): ThreadRecord => ({
  issueId: row.issueId,
  threadUrl: row.threadUrl,
  summary: row.summary,
  files: row.files,
  turns: row.turns,
  syncCount: row.syncCount,
  lastSyncAt: row.lastSyncAt.toISOString(),
  lastSyncBy: row.lastSyncBy,
  decisions,
});

/** The record an agent keeps of the thread linked to a task, its decisions and estimate hints. */
@Injectable()
export class ThreadsService {
  constructor(
    private readonly ds: DataSource,
    private readonly issues: IssuesService,
    private readonly artifacts: ArtifactsService,
    private readonly events: EventsService,
  ) {}

  /** `trama sync`: link the thread, upsert the record, add decisions, attach the PR, suggest time. */
  async sync(
    workspaceId: string,
    caller: SyncCaller,
    idOrKey: string,
    input: ThreadSyncInput,
  ): Promise<ThreadSyncResponse> {
    const clean = cleanSyncInput(input);
    const issue = await this.issues.get(workspaceId, idOrKey);
    assertThreadLinkable(issue.key, issue.threadUrl, clean.threadUrl);
    if (clean.pullRequestUrl && !this.mayAttachArtifacts(caller))
      throw new ForbiddenException('Attaching a pull request needs the artifacts permission');
    // The PR goes first: attaching the same URL again is a no-op, so a retry cannot duplicate it.
    const artifact = clean.pullRequestUrl
      ? await this.attachPullRequest(workspaceId, caller.actor, issue, clean.pullRequestUrl)
      : null;

    return this.ds.transaction(async (m) => {
      // One sync at a time per task: the lock also settles a race between two different threads.
      const [locked] = (await m.query(
        `SELECT "threadUrl", "assigneeId", "projectId" FROM "issues"
          WHERE "id" = $1 AND "workspaceId" = $2 FOR UPDATE`,
        [issue.id, workspaceId],
      )) as { threadUrl: string | null; assigneeId: string | null; projectId: string | null }[];
      if (!locked) throw notFound('Issue', issue.id);
      assertThreadLinkable(issue.key, locked.threadUrl, clean.threadUrl);

      const now = new Date();
      let threadUrl = locked.threadUrl;
      let linked = false;
      if (clean.threadUrl && !threadUrl) {
        threadUrl = clean.threadUrl;
        linked = true;
        await m.update(IssueEntity, { id: issue.id, workspaceId }, { threadUrl, updatedAt: now });
        await this.events.record({
          workspaceId,
          actor: caller.actor,
          type: 'issue.updated',
          subject: { type: 'issue', id: issue.id },
          data: { key: issue.key, fields: ['threadUrl'] },
          manager: m,
        });
      }

      const records = m.getRepository(ThreadRecordEntity);
      const record =
        (await records.findOneBy({ issueId: issue.id })) ??
        records.create({
          issueId: issue.id,
          workspaceId,
          threadUrl: null,
          summary: null,
          files: [],
          turns: null,
          syncCount: 0,
          createdAt: now,
        });
      record.threadUrl = threadUrl;
      if (clean.summary !== undefined) record.summary = clean.summary;
      if (clean.files.length) record.files = mergeFiles(record.files, clean.files, THREAD_FILES_MAX);
      if (clean.turns !== undefined) record.turns = clean.turns;
      record.syncCount += 1;
      record.lastSyncAt = now;
      record.lastSyncBy = caller.actor;
      await records.save(record);

      // one row per decision; the offset keeps the order they were sent in
      const decisionRows = clean.decisions.map((d, i) =>
        m.create(TaskDecisionEntity, {
          id: uid('dc'),
          workspaceId,
          issueId: issue.id,
          text: d.text,
          paths: d.paths,
          threadUrl,
          createdBy: caller.actor,
          createdAt: new Date(now.getTime() + i),
        }),
      );
      if (decisionRows.length) await m.save(decisionRows);

      let timeSuggestion: ThreadSyncResult['timeSuggestion'] = null;
      const owner = caller.userId ?? locked.assigneeId;
      if (clean.activeMinutes !== undefined && owner) {
        const entry = await m.save(
          m.create(TimeEntryEntity, {
            id: uid('te'),
            workspaceId,
            userId: owner,
            projectId: locked.projectId,
            issueId: issue.id,
            description: '',
            source: 'suggested',
            startedAt: new Date(now.getTime() - clean.activeMinutes * 60_000),
            endedAt: now,
            createdAt: now,
            updatedAt: now,
          }),
        );
        timeSuggestion = { id: entry.id, userId: owner, minutes: clean.activeMinutes };
      }

      await this.events.record({
        workspaceId,
        actor: caller.actor,
        type: 'issue.thread_synced',
        subject: { type: 'issue', id: issue.id },
        data: {
          key: issue.key,
          decisions: decisionRows.length,
          files: record.files.length,
          pullRequest: !!artifact,
          minutes: timeSuggestion?.minutes ?? null,
        },
        manager: m,
      });

      const all = await m.find(TaskDecisionEntity, {
        where: { workspaceId, issueId: issue.id },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      return {
        record: toRecord(record, all.map((row) => toDecision(row, issue.key))),
        decisionsAdded: decisionRows.length,
        linked,
        artifact,
        timeSuggestion,
      };
    });
  }

  /** The record of a task, with its decisions (oldest first). 404 when it was never synced. */
  async getRecord(workspaceId: string, idOrKey: string): Promise<ThreadRecord> {
    const issue = await this.issues.get(workspaceId, idOrKey);
    const row = await this.ds.getRepository(ThreadRecordEntity).findOneBy({
      workspaceId,
      issueId: issue.id,
    });
    if (!row) throw notFound('Thread record', issue.key);
    const decisions = await this.ds.getRepository(TaskDecisionEntity).find({
      where: { workspaceId, issueId: issue.id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return toRecord(
      row,
      decisions.map((d) => toDecision(d, issue.key)),
    );
  }

  /**
   * Decisions, newest first. With `path`, the ones that cover that file (same path, a directory
   * prefix or a glob); decisions without paths only match when `issue` is given.
   */
  async listDecisions(
    workspaceId: string,
    q: { path?: string; issue?: string; limit?: number } = {},
  ): Promise<ThreadDecision[]> {
    const limit = Math.min(Math.max(q.limit ?? DECISIONS_DEFAULT_LIMIT, 1), DECISIONS_MAX_LIMIT);
    const issueId = q.issue ? (await this.issues.get(workspaceId, q.issue)).id : undefined;
    const file = q.path?.trim() || undefined;

    const qb = this.ds
      .getRepository(TaskDecisionEntity)
      .createQueryBuilder('d')
      .innerJoin(IssueEntity, 'i', 'i.id = d.issueId')
      .where('d.workspaceId = :workspaceId', { workspaceId })
      .orderBy('d.createdAt', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .limit(file ? DECISIONS_SCAN_MAX : limit);
    if (issueId) qb.andWhere('d.issueId = :issueId', { issueId });
    applyProjectScope(qb, 'i', 'projectId');
    let rows = await qb.getMany();
    if (file)
      rows = rows
        .filter((row) =>
          row.paths.length ? decisionMatchesPath(row.paths, file) : issueId !== undefined,
        )
        .slice(0, limit);

    const keys = await this.issueKeys(workspaceId, rows.map((row) => row.issueId));
    return rows.map((row) => toDecision(row, keys.get(row.issueId) ?? ''));
  }

  /** Points suggested from similar finished tasks of the workspace. People decide. */
  async estimateSuggestion(
    workspace: WorkspaceEntity,
    idOrKey: string,
  ): Promise<EstimateSuggestion> {
    const issue = await this.issues.get(workspace.id, idOrKey);
    const catalog = await loadStatusCatalog(this.ds, workspace.id);
    const qb = this.ds
      .getRepository(IssueEntity)
      .createQueryBuilder('i')
      .where('i.workspaceId = :workspaceId', { workspaceId: workspace.id })
      .andWhere('i.status IN (:...done)', { done: statusIdsForTypes(catalog.issue, ['done']) })
      .andWhere('i.estimate IS NOT NULL')
      .andWhere('i.id <> :id', { id: issue.id })
      .orderBy('i.completedAt', 'DESC', 'NULLS LAST')
      .take(ESTIMATE_CANDIDATES_MAX);
    applyProjectScope(qb, 'i', 'projectId');
    const finished: FinishedTask[] = (await qb.getMany()).map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      projectId: row.projectId,
      labels: row.labels,
      estimate: row.estimate ?? 0,
      trackedMinutes: null,
      completedAt: row.completedAt,
    }));

    const target = { title: issue.title, projectId: issue.projectId, labels: issue.labels };
    const top = rankSimilar(target, finished);
    const tracked = await this.trackedMinutes(
      workspace.id,
      top.map((task) => task.id),
    );
    return buildEstimateSuggestion(
      issue.id,
      target,
      top.map((task) => ({ ...task, trackedMinutes: tracked.get(task.id) ?? null })),
      workspace.resolved().estimateScale,
    );
  }

  /** Minutes of finished, counted entries per task. Suggestions and running timers do not count. */
  private async trackedMinutes(
    workspaceId: string,
    issueIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (!issueIds.length) return new Map();
    const rows = (await this.ds.query(
      `SELECT "issueId", SUM(EXTRACT(EPOCH FROM ("endedAt" - "startedAt"))) / 60 AS "minutes"
         FROM "time_entries"
        WHERE "workspaceId" = $1 AND "issueId" = ANY($2)
          AND "endedAt" IS NOT NULL AND "source" <> 'suggested'
        GROUP BY "issueId"`,
      [workspaceId, issueIds],
    )) as { issueId: string; minutes: string | number }[];
    return new Map(rows.map((row) => [row.issueId, Math.round(Number(row.minutes))]));
  }

  private async issueKeys(workspaceId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.ds.getRepository(IssueEntity).find({
      where: { workspaceId, id: In(unique) },
      select: { id: true, key: true },
    });
    return new Map(rows.map((row) => [row.id, row.key]));
  }

  private mayAttachArtifacts(caller: SyncCaller): boolean {
    const access = currentAccess();
    return caller.canWriteArtifacts && (!access || access.grants.includes('artifacts:create'));
  }

  /** Creates the `pull_request` artifact of the task, or refreshes the one with the same URL. */
  private async attachPullRequest(
    workspaceId: string,
    actor: ActorRef,
    issue: IssueEntity,
    url: string,
  ) {
    const ref = parsePullRequestUrl(url);
    const existing = (await this.artifacts.list(workspaceId, { issueId: issue.id })).find(
      (a) => a.url === url && (a.kind === 'pull_request' || a.kind === 'merge_request'),
    );
    if (existing)
      return this.artifacts.update(workspaceId, actor, existing.id, {
        title: ref.title,
        externalId: ref.externalId,
        repository: ref.repository,
      });
    return this.artifacts.create(workspaceId, actor, {
      issueId: issue.id,
      kind: ref.kind,
      provider: ref.provider,
      title: ref.title,
      url,
      externalId: ref.externalId,
      repository: ref.repository,
    });
  }
}
