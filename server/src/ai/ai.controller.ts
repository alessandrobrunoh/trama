import {
  Auth,
  Ctx,
  RequireUser,
  Roles,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Delete,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiConfig } from './ai.config.js';
import { ChatDto, SuggestionDto } from './ai.dto.js';
import { AiService } from './ai.service.js';
import { GrokBuildService } from './grok-build.service.js';

@Controller('w/:slug/ai')
@RequireUser()
@Roles('viewer')
export class AiController {
  constructor(
    private readonly config: AiConfig,
    private readonly ai: AiService,
    private readonly grok: GrokBuildService,
  ) {}

  @Get('status')
  async status(@Auth() auth: AuthInfo) {
    const userId = this.sessionUser(auth);
    return {
      suggestions: this.config.status(),
      supergrok: await this.grok.status(userId),
      chatgpt: {
        status: 'unavailable' as const,
        reason:
          'ChatGPT plan connections for remotely hosted apps require OpenAI approval. This installation uses the configured AI provider.',
      },
    };
  }

  @Post('supergrok/login')
  @HttpCode(200)
  startGrokLogin(@Auth() auth: AuthInfo) {
    return this.grok.startLogin(this.sessionUser(auth));
  }

  @Delete('supergrok/login')
  disconnectGrok(@Auth() auth: AuthInfo) {
    return this.grok.disconnect(this.sessionUser(auth));
  }

  @Post('suggestions')
  @HttpCode(200)
  suggest(
    @Auth() auth: AuthInfo,
    @Body() dto: SuggestionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.request(auth, response, (signal) =>
      this.ai.suggest(this.sessionUser(auth), dto, signal),
    );
  }

  @Post('chat')
  @HttpCode(200)
  chat(
    @Auth() auth: AuthInfo,
    @Ctx() ctx: WorkspaceContext,
    @Body() dto: ChatDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.request(auth, response, (signal) =>
      this.ai.chat(this.sessionUser(auth), ctx, dto, signal),
    );
  }

  private sessionUser(auth: AuthInfo): string {
    if (auth.method !== 'session' || !auth.user)
      throw new ForbiddenException('AI features require a browser session.');
    return auth.user.id;
  }

  private async request<T>(
    auth: AuthInfo,
    response: Response,
    action: (signal: AbortSignal) => Promise<T>,
  ) {
    const userId = this.sessionUser(auth);
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once('close', close);
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.ai.run(userId, () => action(controller.signal));
    } finally {
      response.off('close', close);
    }
  }
}
