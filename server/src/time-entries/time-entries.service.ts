import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { notFound, uid } from '../common/util.js';
import { IssueEntity } from '../database/entities/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { TimeEntryEntity } from './time-entry.entity.js';

const END_BEFORE_START = 'The end must be after the start';
const NO_TIMER = 'No timer is running';

export interface TimeEntryInput {
  description?: string;
  projectId?: string | null;
  issueId?: string | null;
}

/** A person's own timer. Never reads or writes LunaGest. */
@Injectable()
export class TimeEntriesService {
  constructor(
    @InjectRepository(TimeEntryEntity)
    private readonly entries: Repository<TimeEntryEntity>,
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
    private readonly projects: ProjectsService,
  ) {}

  list(workspaceId: string, userId: string) {
    return this.entries.find({
      where: { workspaceId, userId },
      order: { startedAt: 'DESC' },
      take: 100,
    });
  }

  /** Stops any timer this person already has running, then starts a new one. */
  async start(workspaceId: string, userId: string, input: TimeEntryInput = {}) {
    const target = await this.resolveTarget(workspaceId, input);
    const now = new Date();
    const running = (await this.entries.find({ where: { workspaceId, userId } })).filter(
      (row) => row.endedAt == null,
    );
    for (const row of running) {
      row.endedAt = now;
      row.updatedAt = now;
      await this.entries.save(row);
    }
    return this.entries.save(
      this.entries.create({
        id: uid('te'),
        workspaceId,
        userId,
        projectId: target.projectId,
        issueId: target.issueId,
        description: target.description,
        startedAt: now,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async stop(workspaceId: string, userId: string) {
    const running = (await this.entries.find({ where: { workspaceId, userId } })).filter(
      (row) => row.endedAt == null,
    );
    const row = running[0];
    if (!row || row.userId !== userId) throw new BadRequestException(NO_TIMER);
    const now = new Date();
    if (now < row.startedAt) throw new BadRequestException(END_BEFORE_START);
    row.endedAt = now;
    row.updatedAt = now;
    return this.entries.save(row);
  }

  async add(workspaceId: string, userId: string, input: TimeEntryInput & { startedAt: string; endedAt: string }) {
    const startedAt = parseInstant(input.startedAt);
    const endedAt = parseInstant(input.endedAt);
    if (endedAt <= startedAt) throw new BadRequestException(END_BEFORE_START);
    const target = await this.resolveTarget(workspaceId, input);
    const now = new Date();
    return this.entries.save(
      this.entries.create({
        id: uid('te'),
        workspaceId,
        userId,
        projectId: target.projectId,
        issueId: target.issueId,
        description: target.description,
        startedAt,
        endedAt,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  /** Another person's entry is not found. */
  async remove(workspaceId: string, userId: string, id: string) {
    const row = await this.entries.findOneBy({ id, workspaceId });
    if (!row || row.userId !== userId) throw notFound('Time entry', id);
    await this.entries.delete({ id, workspaceId, userId });
  }

  private async resolveTarget(workspaceId: string, input: TimeEntryInput) {
    const description = input.description?.trim() ?? '';
    if (description.length > 500) throw new BadRequestException('Description is too long');
    let projectId = input.projectId ?? null;
    let issueId = input.issueId ?? null;
    if (projectId) await this.projects.get(workspaceId, projectId);
    if (issueId) {
      const issue = await this.issues.findOneBy({ workspaceId, id: issueId });
      if (!issue) throw notFound('Issue', issueId);
      if (issue.projectId && projectId && issue.projectId !== projectId) {
        throw new BadRequestException('That issue is not in the selected project');
      }
      if (!projectId) projectId = issue.projectId;
    }
    return { description, projectId, issueId };
  }
}

function parseInstant(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid time');
  return date;
}
