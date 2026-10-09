import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import {
  DEFAULT_IMPORT_OPTIONS,
  EXTERNAL_PROVIDER_META,
  IMPORT_ACTIVE_STATUSES,
  resolveLabelCatalog,
  type ActorRef,
  type ExternalProvider,
  type ImportCredentialRef,
  type ImportMapping,
  type ImportPreview,
  type ImportSource,
} from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { MembershipEntity, ProjectEntity, TeamEntity, UserEntity, WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { HttpClient } from '../integrations/http-client.js';
import { CredentialsService, createAdapter, providerFailure } from './credentials.service.js';
import { ImportJobEntity } from './entities.js';
import { emptyProgress } from './import-engine.js';
import { ImportRunnerService } from './import-runner.service.js';
import { buildPreview, mappingFromPreview, parseMapping, parseOptions, type PreviewContext } from './mapping.js';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface ImportRequest extends ImportCredentialRef {
  provider: ExternalProvider;
  source: ImportSource;
  mapping?: unknown;
  options?: unknown;
}

/** `owner/name` from an `owner/name` string or a GitHub URL; anything else is a 400. */
export function parseRepository(raw: string | undefined): string {
  const input = (raw ?? '').trim();
  const isUrl = /^https?:\/\/[^/]+\//i.test(input);
  const parts = input.replace(/^https?:\/\/[^/]+\//i, '').replace(/\/+$/, '').split('/');
  // A URL may carry more path (/issues/4); a plain value must be exactly owner/name.
  if (!isUrl && parts.length !== 2) throw new BadRequestException('source.repository must look like owner/name');
  const repo = parts.slice(0, 2).join('/').replace(/\.git$/i, '');
  if (!REPOSITORY_RE.test(repo) || parts.slice(0, 2).some((p) => p === '.' || p === '..'))
    throw new BadRequestException('source.repository must look like owner/name');
  return repo;
}

export function normalizeSource(provider: ExternalProvider, source: ImportSource | undefined): ImportSource {
  if (provider === 'github') return { repository: parseRepository(source?.repository) };
  const teamIds = [...new Set(source?.teamIds ?? [])];
  if (teamIds.some((t) => !TEAM_ID_RE.test(t))) throw new BadRequestException('source.teamIds contains an invalid id');
  return { teamIds };
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly ds: DataSource,
    private readonly http: HttpClient,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly credentials: CredentialsService,
    private readonly runner: ImportRunnerService,
    @InjectRepository(ImportJobEntity) private readonly jobs: Repository<ImportJobEntity>,
  ) {}

  // ───────────── preview ─────────────

  private async context(workspaceId: string): Promise<PreviewContext> {
    const [memberships, teams, projects, ws] = await Promise.all([
      this.ds.getRepository(MembershipEntity).findBy({ workspaceId }),
      this.ds.getRepository(TeamEntity).findBy({ workspaceId }),
      this.ds.getRepository(ProjectEntity).findBy({ workspaceId }),
      this.ds.getRepository(WorkspaceEntity).findOneByOrFail({ id: workspaceId }),
    ]);
    const users = memberships.length ? await this.ds.getRepository(UserEntity).findBy({ id: In(memberships.map((m) => m.userId)) }) : [];
    return {
      members: users.map((u) => ({ id: u.id, name: u.name, email: u.email })),
      teams: teams.map((t) => ({ id: t.id, name: t.name, key: t.key })),
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      labels: resolveLabelCatalog(ws.settings?.labels).map((l) => ({ id: l.id, name: l.name })),
    };
  }

  async preview(workspaceId: string, req: ImportRequest): Promise<ImportPreview> {
    const source = normalizeSource(req.provider, req.source);
    const cred = await this.credentials.resolve(workspaceId, req.provider, req);
    const label = EXTERNAL_PROVIDER_META[req.provider].label;
    try {
      const discovery = await createAdapter(this.http, req.provider, cred, source).discover();
      return buildPreview(discovery, await this.context(workspaceId));
    } catch (e) {
      throw providerFailure(label, e, [cred.token]);
    }
  }

  // ───────────── jobs ─────────────

  /** Every reference in the mapping must exist in this workspace before a single row is written. */
  private async assertMapping(workspaceId: string, mapping: ImportMapping) {
    const ids = (targets: Record<string, { action: string; id?: string }>) =>
      Object.values(targets).flatMap((t) => (t.action === 'map' && t.id ? [t.id] : []));
    await this.refs.teams(workspaceId, ids(mapping.teams));
    await this.refs.projects(workspaceId, ids(mapping.projects));
    await this.refs.users(workspaceId, Object.values(mapping.users));
    const labelIds = ids(mapping.labels);
    if (labelIds.length) {
      const ws = await this.ds.getRepository(WorkspaceEntity).findOneByOrFail({ id: workspaceId });
      const known = new Set(resolveLabelCatalog(ws.settings?.labels).map((l) => l.id));
      const unknown = labelIds.filter((id) => !known.has(id));
      if (unknown.length) throw new BadRequestException(`Unknown label in: ${[...new Set(unknown)].join(', ')}`);
    }
  }

  async start(workspaceId: string, actor: ActorRef, req: ImportRequest) {
    const source = normalizeSource(req.provider, req.source);
    await this.credentials.resolve(workspaceId, req.provider, req); // the reference must be one of this workspace's
    const options = parseOptions(req.options, DEFAULT_IMPORT_OPTIONS);
    if (await this.jobs.existsBy({ workspaceId, status: In(IMPORT_ACTIVE_STATUSES) }))
      throw new ConflictException('Another import is still running in this workspace');

    let mapping: ImportMapping;
    let sourceLabel = req.provider === 'github' ? source.repository! : `Linear (${source.teamIds?.length ? `${source.teamIds.length} team(s)` : 'all teams'})`;
    if (req.mapping === undefined || req.mapping === null) {
      // No mapping given (an agent, "run with defaults"): use what the preview suggests.
      const preview = await this.preview(workspaceId, req);
      mapping = mappingFromPreview(preview);
      sourceLabel = preview.sourceLabel;
    } else mapping = parseMapping(req.mapping);
    await this.assertMapping(workspaceId, mapping);

    const job = await this.jobs.save(
      this.jobs.create({
        id: uid('imp'),
        workspaceId,
        provider: req.provider,
        status: 'queued',
        sourceLabel: sourceLabel.slice(0, 200),
        source,
        options,
        mapping,
        credential: { credentialId: req.credentialId, connectionId: req.connectionId },
        progress: emptyProgress(),
        errors: [],
        cursor: null,
        waitingUntil: null,
        cancelRequested: false,
        lastError: null,
        heartbeatAt: null,
        createdBy: actor,
        startedAt: null,
        finishedAt: null,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'import.started',
      subject: { type: 'import', id: job.id },
      data: { provider: job.provider, source: job.sourceLabel },
    });
    void this.runner.kick(job.id);
    return job;
  }

  list(workspaceId: string) {
    return this.jobs.find({ where: { workspaceId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.jobs.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Import', id);
    return row;
  }

  async cancel(workspaceId: string, id: string) {
    const job = await this.get(workspaceId, id);
    if (!IMPORT_ACTIVE_STATUSES.includes(job.status)) throw new ConflictException(`The import already ${job.status}`);
    const parked = await this.jobs
      .createQueryBuilder()
      .update()
      .set({ status: 'canceled', finishedAt: new Date(), waitingUntil: null, cancelRequested: true })
      .where(`id = :id AND "workspaceId" = :workspaceId AND status = 'queued' AND "heartbeatAt" IS NULL`, { id, workspaceId })
      .execute();
    // A running job stops at its next page; one that is parked or not yet picked up stops now.
    if (!parked.affected) await this.jobs.update({ id, workspaceId }, { cancelRequested: true });
    return this.get(workspaceId, id);
  }

  async retry(workspaceId: string, id: string) {
    const job = await this.get(workspaceId, id);
    if (job.status !== 'failed') throw new ConflictException('Only a failed import can be retried');
    if (await this.jobs.existsBy({ workspaceId, status: In(IMPORT_ACTIVE_STATUSES) }))
      throw new ConflictException('Another import is still running in this workspace');
    await this.jobs.update({ id, workspaceId }, { status: 'queued', lastError: null, finishedAt: null, cancelRequested: false, heartbeatAt: null, waitingUntil: null });
    void this.runner.kick(id);
    return this.get(workspaceId, id);
  }

  async remove(workspaceId: string, id: string) {
    const job = await this.get(workspaceId, id);
    if (IMPORT_ACTIVE_STATUSES.includes(job.status)) throw new ConflictException('Cancel the import before deleting it');
    await this.jobs.delete({ id, workspaceId });
  }
}
