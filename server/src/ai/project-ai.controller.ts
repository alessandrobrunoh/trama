import {
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  Auth,
  Ctx,
  RequireUser,
  Roles,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { PROJECT_AI_KINDS, type ProjectAiKind } from '../contracts/domain.js';
import { ProjectAiService } from './project-ai.service.js';

/**
 * `POST /w/:slug/projects/:id/ai/:kind` — returns a proposal and changes nothing. Whether the caller
 * may use it (manageProjects, or lead of the project) is checked by the service, which loads the project.
 */
@Controller('w/:slug/projects/:id/ai')
@RequireUser()
@Roles('viewer')
export class ProjectAiController {
  constructor(private readonly service: ProjectAiService) {}

  @Post(':kind')
  @HttpCode(200)
  async suggest(
    @Auth() auth: AuthInfo,
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (auth.method !== 'session' || !auth.user)
      throw new ForbiddenException('AI features require a browser session.');
    if (!PROJECT_AI_KINDS.includes(kind as ProjectAiKind))
      throw new BadRequestException(`kind must be one of: ${PROJECT_AI_KINDS.join(', ')}`);
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once('close', close);
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.service.suggest(auth.user.id, ctx, id, kind as ProjectAiKind, controller.signal);
    } finally {
      response.off('close', close);
    }
  }
}
