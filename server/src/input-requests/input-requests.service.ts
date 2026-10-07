import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, InputRequestState } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { ExecutionEntity, InputRequestEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';

export interface InputRequestInput {
  workstreamId?: string;
  executionId?: string | null;
  question?: string;
  options?: string[] | null;
  assigneeUserId?: string | null;
}

@Injectable()
export class InputRequestsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly bus: WorkstreamBus,
    @InjectRepository(InputRequestEntity) private readonly repo: Repository<InputRequestEntity>,
  ) {}

  list(workspaceId: string, f: { state?: InputRequestState; workstreamId?: string; executionId?: string; assigneeUserId?: string } = {}) {
    const qb = this.repo.createQueryBuilder('r').where('r.workspaceId = :workspaceId', { workspaceId }).orderBy('r.createdAt', 'DESC');
    if (f.state) qb.andWhere('r.state = :s', { s: f.state });
    if (f.workstreamId) qb.andWhere('r.workstreamId = :w', { w: f.workstreamId });
    if (f.executionId) qb.andWhere('r.executionId = :e', { e: f.executionId });
    if (f.assigneeUserId) qb.andWhere('r.assigneeUserId = :a', { a: f.assigneeUserId });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Input request', id);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: InputRequestInput & { question: string }) {
    let workstreamId = input.workstreamId;
    if (input.executionId) {
      const ex = await this.ds.getRepository(ExecutionEntity).findOneBy({ id: input.executionId, workspaceId });
      if (!ex) throw new BadRequestException(`Unknown execution "${input.executionId}"`);
      if (workstreamId && workstreamId !== ex.workstreamId)
        throw new BadRequestException('executionId belongs to a different workstream');
      workstreamId = ex.workstreamId;
    }
    if (!workstreamId) throw new BadRequestException('workstreamId or executionId is required');
    if (!(await this.ds.getRepository(WorkstreamEntity).existsBy({ id: workstreamId, workspaceId })))
      throw new BadRequestException(`Unknown workstream "${workstreamId}"`);
    await this.refs.users(workspaceId, [input.assigneeUserId]);
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ir'),
        workspaceId,
        workstreamId,
        executionId: input.executionId ?? null,
        question: input.question.trim(),
        options: input.options?.length ? input.options : null,
        requestedBy: actor,
        assigneeUserId: input.assigneeUserId ?? null,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.requested',
      subject: { type: 'input_request', id: row.id },
      workstreamId,
      data: { question: row.question, executionId: row.executionId, assigneeUserId: row.assigneeUserId },
    });
    await this.bus.touch(workspaceId, workstreamId, 'input.requested');
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: InputRequestInput) {
    const row = await this.get(workspaceId, id);
    if (row.state !== 'open') throw new ConflictException('Only open input requests can be edited');
    await this.refs.users(workspaceId, [patch.assigneeUserId]);
    if (patch.question !== undefined) row.question = patch.question.trim();
    if (patch.options !== undefined) row.options = patch.options?.length ? patch.options : null;
    if (patch.assigneeUserId !== undefined) row.assigneeUserId = patch.assigneeUserId;
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.updated',
      subject: { type: 'input_request', id },
      workstreamId: row.workstreamId,
      data: { fields: Object.keys(patch) },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'input.updated');
    return row;
  }

  async answer(workspaceId: string, actor: ActorRef, id: string, answer: string) {
    const row = await this.get(workspaceId, id);
    if (row.state !== 'open') throw new ConflictException(`Input request is already ${row.state}`);
    row.state = 'answered';
    row.answer = answer;
    row.answeredById = actor.id ?? null;
    row.answeredAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.answered',
      subject: { type: 'input_request', id },
      workstreamId: row.workstreamId,
      data: { question: row.question, answer },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'input.answered');
    return row;
  }

  async dismiss(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    if (row.state !== 'open') throw new ConflictException(`Input request is already ${row.state}`);
    row.state = 'dismissed';
    row.answeredAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.dismissed',
      subject: { type: 'input_request', id },
      workstreamId: row.workstreamId,
      data: { question: row.question },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'input.dismissed');
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, id]);
    await this.repo.delete({ id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.deleted',
      subject: { type: 'input_request', id },
      workstreamId: row.workstreamId,
      data: { question: row.question },
    });
    await this.bus.touch(workspaceId, row.workstreamId, 'input.deleted');
  }
}
