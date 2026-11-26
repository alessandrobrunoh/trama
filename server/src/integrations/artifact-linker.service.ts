import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { ActorRef, MemberAccess } from '../contracts/domain.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { projectHidden } from '../auth/member-access.js';
import {
  ArtifactEntity,
  IssueEntity,
  MembershipEntity,
} from '../database/entities/index.js';
import { ExternalIdentitiesService } from '../external-identities/external-identities.service.js';
import type { ArtifactCandidate, CiPatch } from './candidates.js';
import { ArtifactSourceEntity } from './entities.js';
import { extractKeys } from './keys.js';

export const SYSTEM_ACTOR: ActorRef = { type: 'system' };

export interface LinkResult {
  created: number;
  updated: number;
  issueKeys: string[];
}

/**
 * Turns normalized provider data into issue-owned Artifacts, matched by Issue keys.
 * It upserts one artifact per (repository, kind, externalId, issue) through
 * ArtifactsService,
 * and remembers git coordinates for later CI events.
 */
@Injectable()
export class ArtifactLinkerService {
  private readonly logger = new Logger(ArtifactLinkerService.name);
  /** In-process serialization per artifact identity (webhooks of one PR arrive in bursts). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ds: DataSource,
    private readonly artifacts: ArtifactsService,
    @Optional()
    @Inject(ExternalIdentitiesService)
    private readonly identities?: ExternalIdentitiesService,
  ) {}

  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  /** Issue key → Issue id for the workspace. */
  async keyMap(workspaceId: string): Promise<Map<string, string>> {
    const rows = await this.ds
      .getRepository(IssueEntity)
      .find({ where: { workspaceId }, select: { id: true, key: true } });
    return new Map(rows.map((issue) => [issue.key, issue.id]));
  }

  /** `source.host` is the git host the event came from (its connection's), for login lookups. */
  upsert(
    workspaceId: string,
    repo: { id: string },
    c: ArtifactCandidate,
    source: { host?: string | null } = {},
  ): Promise<LinkResult> {
    return this.serial(
      `${workspaceId}|${repo.id}|${c.kind}|${c.externalId}`,
      () => this.doUpsert(workspaceId, repo, c, source),
    );
  }

  /**
   * Who the event concerns, from the provider's logins through external identities: the people a
   * review was asked from (workspace members only, so only they hear about it), and, when the sender
   * has a verified identity, the person to credit the activity to instead of "system".
   */
  private async people(
    workspaceId: string,
    c: ArtifactCandidate,
    host: string | null | undefined,
  ): Promise<{
    actor: ActorRef;
    reviewers: { userId: string; access: MemberAccess | null }[];
  }> {
    const reviewers: { userId: string; access: MemberAccess | null }[] = [];
    if (!this.identities) return { actor: SYSTEM_ACTOR, reviewers };
    let actor = SYSTEM_ACTOR;
    try {
      if (c.reviewerLogins?.length) {
        const found = await this.identities.resolveMembersByLogins(
          workspaceId,
          c.provider,
          host,
          c.reviewerLogins,
        );
        const ids = [...new Set(found.values())];
        const memberships = ids.length
          ? await this.ds
              .getRepository(MembershipEntity)
              .findBy({ workspaceId, userId: In(ids) })
          : [];
        for (const m of memberships)
          reviewers.push({ userId: m.userId, access: m.access });
      }
      if (c.actorLogin) {
        const userId = await this.identities.resolveMemberByLogin(
          workspaceId,
          c.provider,
          host,
          c.actorLogin,
          { verifiedOnly: true },
        );
        if (userId) actor = { type: 'user', id: userId };
      }
    } catch (e) {
      // A lookup problem must not drop the webhook: fall back to the system actor.
      this.logger.warn(`Login lookup failed: ${(e as Error).message}`);
    }
    return { actor, reviewers };
  }

  /** Reviewers who may see the task: someone limited to other projects is not told about it. */
  private async reviewersWhoCanSee(
    issueId: string,
    reviewers: { userId: string; access: MemberAccess | null }[],
  ): Promise<string[] | undefined> {
    if (!reviewers.length) return undefined;
    let projectId: string | null | undefined;
    if (reviewers.some((r) => r.access && !r.access.projects.all))
      projectId = (
        await this.ds
          .getRepository(IssueEntity)
          .findOne({ where: { id: issueId }, select: { id: true, projectId: true } })
      )?.projectId;
    const visible = reviewers
      .filter((r) => !projectHidden(r.access, projectId))
      .map((r) => r.userId);
    return visible.length ? visible : undefined;
  }

  private async doUpsert(
    workspaceId: string,
    repo: { id: string },
    c: ArtifactCandidate,
    source: { host?: string | null },
  ): Promise<LinkResult> {
    const keyMap = await this.keyMap(workspaceId);
    const keys = [
      ...new Set([
        ...extractKeys(c.texts, { known: keyMap }),
        ...extractKeys(c.branchTexts, { known: keyMap, ignoreCase: true }),
      ]),
    ];
    const artifactRepo = this.ds.getRepository(ArtifactEntity);
    const existing = await artifactRepo.findBy({
      workspaceId,
      repository: repo.id,
      kind: c.kind,
      externalId: c.externalId,
    });
    const byIssue = new Map(
      existing.flatMap((a) => (a.issueId ? [[a.issueId, a] as const] : [])),
    );
    const targets = new Set<string>([
      ...keys.map((k) => keyMap.get(k)!),
      ...byIssue.keys(),
    ]);
    const result: LinkResult = { created: 0, updated: 0, issueKeys: keys };
    const { actor, reviewers } = targets.size
      ? await this.people(workspaceId, c, source.host)
      : { actor: SYSTEM_ACTOR, reviewers: [] };

    for (const issueId of targets) {
      const current = byIssue.get(issueId);
      const reviewerUserIds = await this.reviewersWhoCanSee(issueId, reviewers);
      const applyReview =
        c.review !== undefined &&
        (!c.reviewOnlyFrom ||
          !current ||
          c.reviewOnlyFrom.includes(current.review ?? 'none'));
      let row: ArtifactEntity;
      if (current) {
        row = await this.artifacts.update(workspaceId, actor, current.id, {
          title: c.title,
          url: c.url,
          state: c.state,
          ci: c.ci,
          review: applyReview ? c.review : undefined,
          hasConflicts: c.hasConflicts,
          reviewerUserIds,
        });
        if (row.updatedAt.getTime() > current.updatedAt.getTime())
          result.updated++;
      } else {
        row = await this.artifacts.create(workspaceId, actor, {
          issueId,
          reviewerUserIds,
          kind: c.kind,
          provider: c.provider,
          title: c.title,
          url: c.url,
          externalId: c.externalId,
          repository: repo.id,
          state: c.state,
          ci: c.ci,
          review: c.review,
          hasConflicts: c.hasConflicts,
        });
        result.created++;
      }
      if (c.headSha || c.headBranch)
        await this.ds.getRepository(ArtifactSourceEntity).upsert(
          {
            artifactId: row.id,
            workspaceId,
            repository: repo.id,
            ...(c.headSha ? { headSha: c.headSha } : {}),
            ...(c.headBranch ? { headBranch: c.headBranch } : {}),
          },
          ['artifactId'],
        );
    }
    return result;
  }

  /** Applies a CI result to the PR/MR artifacts of a commit. Returns how many artifacts changed. */
  async applyCi(
    workspaceId: string,
    repo: { id: string },
    patch: CiPatch,
  ): Promise<number> {
    const ids = new Set<string>();
    if (patch.sha) {
      const sources = await this.ds
        .getRepository(ArtifactSourceEntity)
        .createQueryBuilder('s')
        .where(
          's.workspaceId = :workspaceId AND s.repository = :repo AND s.headSha = :sha',
          { workspaceId, repo: repo.id, sha: patch.sha },
        )
        .getMany();
      for (const s of sources) ids.add(s.artifactId);
    }
    if (patch.prExternalIds?.length) {
      const rows = await this.ds.getRepository(ArtifactEntity).find({
        where: {
          workspaceId,
          repository: repo.id,
          externalId: In(patch.prExternalIds),
        },
        select: { id: true, kind: true },
      });
      for (const r of rows)
        if (r.kind === 'pull_request' || r.kind === 'merge_request')
          ids.add(r.id);
    }
    let changed = 0;
    for (const id of ids) {
      try {
        const before = await this.ds
          .getRepository(ArtifactEntity)
          .findOneBy({ id });
        if (!before || before.ci === patch.ci) continue;
        await this.artifacts.update(workspaceId, SYSTEM_ACTOR, id, {
          ci: patch.ci,
        });
        changed++;
      } catch (e) {
        this.logger.warn(`CI update of ${id} failed: ${(e as Error).message}`);
      }
    }
    return changed;
  }
}
