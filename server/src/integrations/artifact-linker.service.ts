import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import {
  ArtifactEntity,
  type RepositoryEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import type { ArtifactCandidate, CiPatch } from './candidates.js';
import { ArtifactSourceEntity } from './entities.js';
import { extractKeys } from './keys.js';

export const SYSTEM_ACTOR: ActorRef = { type: 'system' };

export interface LinkResult {
  created: number;
  updated: number;
  workstreamKeys: string[];
}

/**
 * Turns normalized provider data into Artifacts: finds the workstreams by key,
 * upserts one artifact per (repository, kind, externalId, workstream) through
 * ArtifactsService (so events + WorkstreamBus.touch happen exactly as for manual edits),
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

  /** key (AUTH-42) → workstream id for the whole workspace. */
  async keyMap(workspaceId: string): Promise<Map<string, string>> {
    const rows = await this.ds.getRepository(WorkstreamEntity).find({ where: { workspaceId }, select: { id: true, key: true } });
    return new Map(rows.map((w) => [w.key, w.id]));
  }

  upsert(workspaceId: string, repo: RepositoryEntity, c: ArtifactCandidate): Promise<LinkResult> {
    return this.serial(`${workspaceId}|${repo.id}|${c.kind}|${c.externalId}`, () => this.doUpsert(workspaceId, repo, c));
  }

  private async doUpsert(workspaceId: string, repo: RepositoryEntity, c: ArtifactCandidate): Promise<LinkResult> {
    const keyMap = await this.keyMap(workspaceId);
    const keys = [
      ...new Set([
        ...extractKeys(c.texts, { known: keyMap }),
        ...extractKeys(c.branchTexts, { known: keyMap, ignoreCase: true }),
      ]),
    ];
    const artifactRepo = this.ds.getRepository(ArtifactEntity);
    const existing = await artifactRepo.findBy({ workspaceId, repositoryId: repo.id, kind: c.kind, externalId: c.externalId });
    const byWorkstream = new Map(existing.map((a) => [a.workstreamId, a]));
    const targets = new Set<string>([...keys.map((k) => keyMap.get(k)!), ...byWorkstream.keys()]);
    const result: LinkResult = { created: 0, updated: 0, workstreamKeys: keys };

    for (const workstreamId of targets) {
      const current = byWorkstream.get(workstreamId);
      const applyReview = c.review !== undefined && (!c.reviewOnlyFrom || !current || c.reviewOnlyFrom.includes(current.review ?? 'none'));
      let row: ArtifactEntity;
      if (current) {
        row = await this.artifacts.update(workspaceId, SYSTEM_ACTOR, current.id, {
          title: c.title,
          url: c.url,
          state: c.state,
          ci: c.ci,
          review: applyReview ? c.review : undefined,
          hasConflicts: c.hasConflicts,
        });
        if (row.updatedAt.getTime() > current.updatedAt.getTime()) result.updated++;
      } else {
        row = await this.artifacts.create(workspaceId, SYSTEM_ACTOR, {
          workstreamId,
          kind: c.kind,
          provider: c.provider,
          title: c.title,
          url: c.url,
          externalId: c.externalId,
          repositoryId: repo.id,
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
            repositoryId: repo.id,
            ...(c.headSha ? { headSha: c.headSha } : {}),
            ...(c.headBranch ? { headBranch: c.headBranch } : {}),
          },
          ['artifactId'],
        );
    }
    return result;
  }

  /** Applies a CI result to the PR/MR artifacts of a commit. Returns how many artifacts changed. */
  async applyCi(workspaceId: string, repo: RepositoryEntity, patch: CiPatch): Promise<number> {
    const ids = new Set<string>();
    if (patch.sha) {
      const sources = await this.ds
        .getRepository(ArtifactSourceEntity)
        .createQueryBuilder('s')
        .where('s.workspaceId = :workspaceId AND s.repositoryId = :repo AND s.headSha = :sha', { workspaceId, repo: repo.id, sha: patch.sha })
        .getMany();
      for (const s of sources) ids.add(s.artifactId);
    }
    if (patch.prExternalIds?.length) {
      const rows = await this.ds.getRepository(ArtifactEntity).find({
        where: { workspaceId, repositoryId: repo.id, externalId: In(patch.prExternalIds) },
        select: { id: true, kind: true },
      });
      for (const r of rows) if (r.kind === 'pull_request' || r.kind === 'merge_request') ids.add(r.id);
    }
    let changed = 0;
    for (const id of ids) {
      try {
        const before = await this.ds.getRepository(ArtifactEntity).findOneBy({ id });
        if (!before || before.ci === patch.ci) continue;
        await this.artifacts.update(workspaceId, SYSTEM_ACTOR, id, { ci: patch.ci });
        changed++;
      } catch (e) {
        this.logger.warn(`CI update of ${id} failed: ${(e as Error).message}`);
      }
    }
    return changed;
  }
}
