import { Controller, Get, Header, Param } from '@nestjs/common';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { ProjectContextService } from './project-context.service.js';

@Controller('w/:slug/projects/:id')
export class ProjectContextController {
  constructor(private readonly service: ProjectContextService) {}

  /** The whole project tree as JSON (`ProjectContext`). */
  @Get('context')
  context(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.build(ctx.workspace.id, id);
  }

  /** The same tree as a markdown briefing for agents. */
  @Get('context.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  markdown(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.markdown(ctx.workspace.id, id);
  }
}
