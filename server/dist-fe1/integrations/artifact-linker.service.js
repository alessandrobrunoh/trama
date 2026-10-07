var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ArtifactLinkerService_1;
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { ArtifactEntity, ExecutionEntity, WorkstreamEntity, } from '../database/entities/index.js';
import { ArtifactSourceEntity } from './entities.js';
import { extractKeys } from './keys.js';
export const SYSTEM_ACTOR = { type: 'system' };
let ArtifactLinkerService = ArtifactLinkerService_1 = class ArtifactLinkerService {
    ds;
    artifacts;
    logger = new Logger(ArtifactLinkerService_1.name);
    locks = new Map();
    constructor(ds, artifacts) {
        this.ds = ds;
        this.artifacts = artifacts;
    }
    async serial(key, fn) {
        const prev = this.locks.get(key) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(fn);
        this.locks.set(key, next);
        try {
            return await next;
        }
        finally {
            if (this.locks.get(key) === next)
                this.locks.delete(key);
        }
    }
    async keyMap(workspaceId) {
        const rows = await this.ds.getRepository(WorkstreamEntity).find({ where: { workspaceId }, select: { id: true, key: true } });
        return new Map(rows.map((w) => [w.key, w.id]));
    }
    upsert(workspaceId, repo, c) {
        return this.serial(`${workspaceId}|${repo.id}|${c.kind}|${c.externalId}`, () => this.doUpsert(workspaceId, repo, c));
    }
    async doUpsert(workspaceId, repo, c) {
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
        const targets = new Set([...keys.map((k) => keyMap.get(k)), ...byWorkstream.keys()]);
        const result = { created: 0, updated: 0, workstreamKeys: keys };
        for (const workstreamId of targets) {
            const current = byWorkstream.get(workstreamId);
            const executionId = current?.executionId ??
                (c.headBranch
                    ? (await this.ds.getRepository(ExecutionEntity).findOne({ where: { workspaceId, workstreamId, branch: c.headBranch }, select: { id: true } }))?.id
                    : undefined);
            const applyReview = c.review !== undefined && (!c.reviewOnlyFrom || !current || c.reviewOnlyFrom.includes(current.review ?? 'none'));
            let row;
            if (current) {
                row = await this.artifacts.update(workspaceId, SYSTEM_ACTOR, current.id, {
                    title: c.title,
                    url: c.url,
                    state: c.state,
                    ci: c.ci,
                    review: applyReview ? c.review : undefined,
                    hasConflicts: c.hasConflicts,
                    executionId: executionId ?? undefined,
                });
                if (row.updatedAt.getTime() > current.updatedAt.getTime())
                    result.updated++;
            }
            else {
                row = await this.artifacts.create(workspaceId, SYSTEM_ACTOR, {
                    workstreamId,
                    kind: c.kind,
                    provider: c.provider,
                    title: c.title,
                    url: c.url,
                    externalId: c.externalId,
                    repositoryId: repo.id,
                    executionId,
                    state: c.state,
                    ci: c.ci,
                    review: c.review,
                    hasConflicts: c.hasConflicts,
                });
                result.created++;
            }
            if (c.headSha || c.headBranch)
                await this.ds.getRepository(ArtifactSourceEntity).upsert({
                    artifactId: row.id,
                    workspaceId,
                    repositoryId: repo.id,
                    ...(c.headSha ? { headSha: c.headSha } : {}),
                    ...(c.headBranch ? { headBranch: c.headBranch } : {}),
                }, ['artifactId']);
        }
        return result;
    }
    async applyCi(workspaceId, repo, patch) {
        const ids = new Set();
        if (patch.sha) {
            const sources = await this.ds
                .getRepository(ArtifactSourceEntity)
                .createQueryBuilder('s')
                .where('s.workspaceId = :workspaceId AND s.repositoryId = :repo AND s.headSha = :sha', { workspaceId, repo: repo.id, sha: patch.sha })
                .getMany();
            for (const s of sources)
                ids.add(s.artifactId);
        }
        if (patch.prExternalIds?.length) {
            const rows = await this.ds.getRepository(ArtifactEntity).find({
                where: { workspaceId, repositoryId: repo.id, externalId: In(patch.prExternalIds) },
                select: { id: true, kind: true },
            });
            for (const r of rows)
                if (r.kind === 'pull_request' || r.kind === 'merge_request')
                    ids.add(r.id);
        }
        let changed = 0;
        for (const id of ids) {
            try {
                const before = await this.ds.getRepository(ArtifactEntity).findOneBy({ id });
                if (!before || before.ci === patch.ci)
                    continue;
                await this.artifacts.update(workspaceId, SYSTEM_ACTOR, id, { ci: patch.ci });
                changed++;
            }
            catch (e) {
                this.logger.warn(`CI update of ${id} failed: ${e.message}`);
            }
        }
        return changed;
    }
};
ArtifactLinkerService = ArtifactLinkerService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource,
        ArtifactsService])
], ArtifactLinkerService);
export { ArtifactLinkerService };
//# sourceMappingURL=artifact-linker.service.js.map