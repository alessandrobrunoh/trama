import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, InputRequestState } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import {
  applyProjectScope,
  assertCanUseProject,
  canView,
  currentAccess,
} from '../auth/member-access.js';
import { InputRequestEntity, IssueEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface InputRequestInput {
  issueId?: string;
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
    @InjectRepository(InputRequestEntity)
    private readonly repo: Repository<InputRequestEntity>,
  ) {}

  async list(
    workspaceId: string,
    f: {
      state?: InputRequestState;
      issueId?: string;
      assigneeUserId?: string;
    } = {},
  ) {
    const qb = this.repo
      .createQueryBuilder('r')
      .where('r.workspaceId = :workspaceId', { workspaceId })
      .orderBy('r.createdAt', 'DESC');
    const access = currentAccess();
    if (access) {
      if (!canView('issues', access) || !canView('input-requests', access))
        return [];
      qb.innerJoin(
        IssueEntity,
        'issue',
        'issue.id = r.issueId AND issue.workspaceId = r.workspaceId',
      );
      // Legacy unlinked Questions have no Issue whose project visibility can be checked.
      qb.andWhere('issue.id IS NOT NULL');
      applyProjectScope(qb, 'issue', 'projectId');
    }
    if (f.state) qb.andWhere('r.state = :s', { s: f.state });
    if (f.issueId) qb.andWhere('r.issueId = :i', { i: f.issueId });
    if (f.assigneeUserId)
      qb.andWhere('r.assigneeUserId = :a', { a: f.assigneeUserId });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Input request', id);
    const access = currentAccess();
    if (access) {
      if (
        !row.issueId ||
        !canView('issues', access) ||
        !canView('input-requests', access)
      )
        throw new ForbiddenException('Outside the issues you can access');
      const issue = await this.ds
        .getRepository(IssueEntity)
        .findOneBy({ id: row.issueId, workspaceId });
      if (!issue) throw notFound('Issue', row.issueId);
      assertCanUseProject(issue.projectId);
    }
    return row;
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: InputRequestInput & { question: string; issueId: string },
  ) {
    if (!input.issueId) throw new BadRequestException('issueId is required');
    const issue = await this.ds
      .getRepository(IssueEntity)
      .findOneBy({ id: input.issueId, workspaceId });
    if (!issue)
      throw new BadRequestException(`Unknown issue "${input.issueId}"`);
    const access = currentAccess();
    if (
      access &&
      (!canView('issues', access) || !canView('input-requests', access))
    )
      throw new ForbiddenException('Outside the issues you can access');
    assertCanUseProject(issue.projectId);
    await this.refs.users(workspaceId, [input.assigneeUserId]);
    const row = await this.repo.save(
      this.repo.create({
        id: uid('ir'),
        workspaceId,
        issueId: issue.id,
        legacyWorkstreamKey: null,
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
      data: {
        question: row.question,
        assigneeUserId: row.assigneeUserId,
        issueId: row.issueId,
      },
    });
    return row;
  }

  async update(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    patch: InputRequestInput,
  ) {
    const row = await this.get(workspaceId, id);
    if (row.state !== 'open')
      throw new ConflictException('Only open input requests can be edited');
    await this.refs.users(workspaceId, [patch.assigneeUserId]);
    if (patch.question !== undefined) row.question = patch.question.trim();
    if (patch.options !== undefined)
      row.options = patch.options?.length ? patch.options : null;
    if (patch.assigneeUserId !== undefined)
      row.assigneeUserId = patch.assigneeUserId;
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.updated',
      subject: { type: 'input_request', id },
      data: {
        fields: Object.keys(patch).filter(
          (k) => (patch as Record<string, unknown>)[k] !== undefined,
        ),
      },
    });
    return row;
  }

  async answer(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    answer: string,
  ) {
    const row = await this.get(workspaceId, id);
    if (row.state !== 'open')
      throw new ConflictException(`Input request is already ${row.state}`);
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
      data: { question: row.question, answer, issueId: row.issueId },
    });
    return row;
  }

  async dismiss(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    if (row.state !== 'open')
      throw new ConflictException(`Input request is already ${row.state}`);
    row.state = 'dismissed';
    row.answeredAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.dismissed',
      subject: { type: 'input_request', id },
      data: { question: row.question, issueId: row.issueId },
    });
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    await this.ds.query(
      `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`,
      [workspaceId, id],
    );
    await this.repo.delete({ id, workspaceId });
    await this.events.record({
      workspaceId,
      actor,
      type: 'input.deleted',
      subject: { type: 'input_request', id },
      data: { question: row.question, issueId: row.issueId },
    });
  }
}
