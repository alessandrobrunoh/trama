import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import type { Request, Response } from 'express';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { AgentContextService } from './agent-context.service.js';

class ContextQuery {
  @IsOptional() @IsIn(['markdown', 'json']) format?: 'markdown' | 'json';
}

@Controller('w/:slug/workstreams/:idOrKey/context')
export class AgentContextController {
  constructor(private readonly service: AgentContextService) {}

  /** `text/markdown` by default; JSON with `Accept: application/json` or `?format=json`. */
  @Get()
  async get(
    @Ctx() ctx: WorkspaceContext,
    @Param('idOrKey') idOrKey: string,
    @Query() q: ContextQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const context = await this.service.build(ctx.workspace.id, idOrKey);
    const wantsJson = q.format ? q.format === 'json' : req.accepts(['text/markdown', 'application/json']) === 'application/json';
    if (wantsJson) return context;
    res.type('text/markdown; charset=utf-8');
    return AgentContextService.toMarkdown(context);
  }
}
