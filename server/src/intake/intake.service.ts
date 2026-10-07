import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import {
  INTAKE_KEY_PREFIX,
  type ActorRef,
  type IntakeKind,
  type IntakeSource,
  type IntakeState,
  type Priority,
} from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { IntakeItemEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { WorkstreamsService, type WorkstreamInput } from '../workstreams/workstreams.service.js';

export interface IntakeInput {
  title?: string;
  body?: string | null;
  source?: IntakeSource;
  reporterName?: string | null;
  teamId?: string | null;
  priority?: Priority;
  externalUrl?: string | null;
  workstreamIds?: string[];
}

export interface TriageInput {
  state: IntakeState;
  workstreamIds?: string[];
  createWorkstream?: WorkstreamInput & { title: string; ownerTeamId: string };
  duplicateOfId?: string;
  teamId?: string | null;
  priority?: Priority;
}

const KEY_RE = /^[A-Za-z]+-\d+$/;

@Injectable()
export class IntakeService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly counters: CountersService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    private readonly workstreams: WorkstreamsService,
    @InjectRepository(IntakeItemEntity) private readonly repo: Repository<IntakeItemEntity>,
  ) {}

  list(workspaceId: string, f: { kind?: IntakeKind; state?: IntakeState; teamId?: string; workstreamId?: string; q?: string } = {}) {
    const qb = this.repo.createQueryBuilder('i').where('i.workspaceId = :workspaceId', { workspaceId }).orderBy('i.createdAt', 'DESC');
    if (f.kind) qb.andWhere('i.kind = :k', { k: f.kind });
    if (f.state) qb.andWhere('i.state = :s', { s: f.state });
    if (f.teamId) qb.andWhere('i.teamId = :t', { t: f.teamId });
    if (f.workstreamId) qb.andWhere('i.workstreamIds @> :w::jsonb', { w: JSON.stringify([f.workstreamId]) });
    if (f.q) qb.andWhere('(i.title ILIKE :q OR i.key ILIKE :q)', { q: `%${f.q}%` });
    return qb.getMany();
  }

  /** `idOrKey`: id (`in_…`) or key (`BUG-142`). */
  async get(workspaceId: string, idOrKey: string) {
    const row = await this.repo.findOneBy(
      KEY_RE.test(idOrKey) ? { workspaceId, key: idOrKey.toUpperCase() } : { workspaceId, id: idOrKey },
    );
    if (!row) throw notFound('Intake item', idOrKey);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: IntakeInput & { kind: IntakeKind; title: string }) {
    await this.refs.teams(workspaceId, [input.teamId].filter((x): x is string => !!x));
    const row = await this.ds.transaction(async (m) => {
      const number = await this.counters.next(m, workspaceId, `intake:${input.kind}`);
      return m.save(
        m.create(IntakeItemEntity, {
          id: uid('in'),
          workspaceId,
          key: `${INTAKE_KEY_PREFIX[input.kind]}-${number}`,
          number,
          kind: input.kind,
          title: input.title.trim(),
          body: input.body ?? null,
          source: input.source ?? (actor.type === 'agent' ? 'agent' : 'manual'),
          reporterName: input.reporterName ?? null,
          reporterId: actor.type === 'user' ? (actor.id ?? null) : null,
          teamId: input.teamId ?? null,
          priority: input.priority ?? 'none',
          externalUrl: input.externalUrl ?? null,
        }),
      );
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'intake.created',
      subject: { type: 'intake', id: row.id },
      data: { key: row.key, kind: row.kind, title: row.title },
    });
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: IntakeInput) {
    const row = await this.get(workspaceId, idOrKey);
    await this.refs.teams(workspaceId, [patch.teamId].filter((x): x is string => !!x));
    await this.refs.workstreams(workspaceId, patch.workstreamIds);
    const before = new Set(row.workstreamIds);
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.reporterName !== undefined) row.reporterName = patch.reporterName;
    if (patch.teamId !== undefined) row.teamId = patch.teamId;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.externalUrl !== undefined) row.externalUrl = patch.externalUrl;
    if (patch.workstreamIds !== undefined) row.workstreamIds = unique(patch.workstreamIds);
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'intake.updated',
      subject: { type: 'intake', id: row.id },
      data: { key: row.key, fields: Object.keys(patch) },
    });
    const touched = new Set([...before, ...row.workstreamIds]);
    await this.bus.touchMany(workspaceId, touched, 'intake.updated');
    return row;
  }

  /**
   * Triage: moves the item to `state` and links it to existing workstreams and/or a newly
   * created one (`createWorkstream`, created atomically). Duplicates need `duplicateOfId`.
   */
  async triage(workspaceId: string, actor: ActorRef, idOrKey: string, input: TriageInput) {
    const row = await this.get(workspaceId, idOrKey);
    await this.refs.workstreams(workspaceId, input.workstreamIds);
    await this.refs.teams(workspaceId, [input.teamId].filter((x): x is string => !!x));
    let duplicateOfId: string | null = null;
    if (input.state === 'duplicate') {
      if (!input.duplicateOfId) throw new BadRequestException('duplicateOfId is required when state is "duplicate"');
      const target = await this.get(workspaceId, input.duplicateOfId);
      if (target.id === row.id) throw new BadRequestException('An item cannot duplicate itself');
      duplicateOfId = target.id;
    } else if (input.duplicateOfId) {
      throw new BadRequestException('duplicateOfId is only valid when state is "duplicate"');
    }
    if ((input.state === 'declined' || input.state === 'duplicate' || input.state === 'new') && (input.createWorkstream || input.workstreamIds?.length))
      throw new BadRequestException(`Cannot link workstreams when state is "${input.state}"`);

    let created: Awaited<ReturnType<WorkstreamsService['create']>> | undefined;
    const previous = row.workstreamIds;
    await this.ds.transaction(async (m) => {
      const ids = unique([...(row.workstreamIds ?? []), ...(input.workstreamIds ?? [])]);
      if (input.createWorkstream) {
        created = await this.workstreams.create(workspaceId, actor, input.createWorkstream, {
          manager: m,
          data: { fromIntake: row.key },
        });
        ids.push(created.id);
      }
      row.state = input.state;
      row.workstreamIds = input.state === 'declined' || input.state === 'duplicate' ? [] : ids;
      row.duplicateOfId = duplicateOfId;
      if (input.teamId !== undefined) row.teamId = input.teamId;
      if (input.priority !== undefined) row.priority = input.priority;
      row.updatedAt = new Date();
      await m.save(row);
    });
    if (created) await created.after?.();
    const targets = row.workstreamIds.length ? row.workstreamIds : [null];
    for (const workstreamId of targets)
      await this.events.record({
        workspaceId,
        actor,
        type: 'intake.triaged',
        subject: { type: 'intake', id: row.id },
        workstreamId,
        data: { key: row.key, state: row.state, workstreamIds: row.workstreamIds, createdWorkstreamId: created?.id, duplicateOfId },
      });
    await this.bus.touchMany(workspaceId, [...previous, ...row.workstreamIds], 'intake.triaged');
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const row = await this.get(workspaceId, idOrKey);
    await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, row.id]);
    await this.ds.query(`UPDATE "intake_items" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = $2`, [workspaceId, row.id]);
    await this.repo.delete({ id: row.id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'intake.deleted',
      subject: { type: 'intake', id: row.id },
      data: { key: row.key, title: row.title },
    });
    await this.bus.touchMany(workspaceId, row.workstreamIds, 'intake.deleted');
  }
}
