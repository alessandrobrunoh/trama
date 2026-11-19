import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, type Repository } from 'typeorm';
import { IssueEntity, ProjectEntity } from '../database/entities/index.js';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { ChatContextDto } from './ai.dto.js';

@Injectable()
export class AiContextService {
  constructor(
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
  ) {}

  /** `withTools`: the model can look records up itself, so no record lists are pre-loaded into the prompt. */
  async resolve(
    ctx: WorkspaceContext,
    context?: ChatContextDto,
    withTools = false,
  ): Promise<string> {
    if (!context) return 'No page data has been shared.';
    const workspaceId = ctx.workspace.id;
    const id = context.id;
    const base = { workspace: ctx.workspace.name, page: context.label };
    if (!id || context.kind === 'page') {
      if (withTools)
        return JSON.stringify({
          ...base,
          note: 'Only the page name is shared. Use the tools to look up any record.',
        });
      const mine = ctx.userId
        ? await this.assignedIssues(workspaceId, ctx.userId)
        : [];
      return JSON.stringify({
        ...base,
        note: 'Only the page name and the user’s own open issues (key, title, status, priority) are shared; no other workspace records are available.',
        myOpenIssues: mine,
      });
    }
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
    const item = await this.projects.findOneBy({ workspaceId, id });
    if (!item) throw new NotFoundException('Project not found');
    return JSON.stringify({
      ...base,
      project: {
        name: item.name,
        key: item.key,
        summary: item.summary,
        status: item.status,
        repository: item.repository,
      },
    });
  }

  /** The caller's open issues, most urgent first. Titles only, never descriptions. */
  private async assignedIssues(workspaceId: string, userId: string) {
    const rank: Record<string, number> = {
      urgent: 0,
      high: 1,
      medium: 2,
      low: 3,
      none: 4,
    };
    const items = await this.issues.find({
      where: {
        workspaceId,
        assigneeId: userId,
        status: Not(In(['done', 'canceled'])),
      },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
    return items
      .sort((a, b) => (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4))
      .slice(0, 25)
      .map((i) => ({
        key: i.key,
        title: i.title,
        status: i.status,
        priority: i.priority,
        kind: i.kind,
      }));
  }
}
