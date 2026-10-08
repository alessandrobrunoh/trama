import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
  DecisionEntity,
  IssueEntity,
  RepositoryEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { ChatContextDto } from './ai.dto.js';

@Injectable()
export class AiContextService {
  constructor(
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
    @InjectRepository(WorkstreamEntity)
    private readonly workstreams: Repository<WorkstreamEntity>,
    @InjectRepository(RepositoryEntity)
    private readonly projects: Repository<RepositoryEntity>,
    @InjectRepository(DecisionEntity)
    private readonly decisions: Repository<DecisionEntity>,
  ) {}

  async resolve(
    ctx: WorkspaceContext,
    context?: ChatContextDto,
  ): Promise<string> {
    if (!context) return 'No page data has been shared.';
    const workspaceId = ctx.workspace.id;
    const id = context.id;
    const base = { workspace: ctx.workspace.name, page: context.label };
    if (!id || context.kind === 'page')
      return JSON.stringify({
        ...base,
        note: 'Only the page name is shared; no workspace records are available.',
      });
    const where = [
      { workspaceId, id },
      { workspaceId, key: id },
    ];
    if (context.kind === 'issue') {
      const item = await this.issues.findOne({ where });
      if (!item) throw new NotFoundException('Issue not found');
      return JSON.stringify({
        ...base,
        issue: {
          key: item.key,
          title: item.title,
          body: item.body?.slice(0, 14000),
          status: item.status,
          priority: item.priority,
          kind: item.kind,
        },
      });
    }
    if (context.kind === 'workstream') {
      const item = await this.workstreams.findOne({ where });
      if (!item) throw new NotFoundException('Workstream not found');
      return JSON.stringify({
        ...base,
        workstream: {
          key: item.key,
          title: item.title,
          description: item.description?.slice(0, 10000),
          objective: item.objective?.slice(0, 4000),
          status: item.status,
          targetDate: item.targetDate,
        },
      });
    }
    if (context.kind === 'decision') {
      const item = await this.decisions.findOne({ where });
      if (!item) throw new NotFoundException('Decision not found');
      return JSON.stringify({
        ...base,
        decision: {
          key: item.key,
          title: item.title,
          statement: item.statement?.slice(0, 10000),
          rationale: item.rationale?.slice(0, 4000),
          status: item.status,
        },
      });
    }
    const item = await this.projects.findOneBy({ workspaceId, id });
    if (!item) throw new NotFoundException('Project not found');
    return JSON.stringify({
      ...base,
      project: { fullName: item.fullName, provider: item.provider },
    });
  }
}
