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
  HttpException,
  Delete,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiConfig } from './ai.config.js';
import { ChatDto, SuggestionDto } from './ai.dto.js';
import { AiService } from './ai.service.js';
import type { ChatSink } from './activity.js';
import { AiProvider } from './ai-provider.js';
import { GrokBuildService } from './grok-build.service.js';

@Controller('w/:slug/ai')
@RequireUser()
@Roles('viewer')
export class AiController {
  constructor(
    private readonly config: AiConfig,
    private readonly ai: AiService,
    private readonly grok: GrokBuildService,
    private readonly provider: AiProvider,
  ) {}

  @Get('status')
  async status(@Auth() auth: AuthInfo) {
    const userId = this.sessionUser(auth);
    return {
      suggestions: this.config.status(),
      supergrok: await this.grok.status(userId),
      assistantTools: {
        enabled:
          this.ai.toolsEnabled() && (await this.provider.supportsTools(userId)),
      },
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

  /**
   * Same as `chat`, but streams what happens as server-sent events: `working`, `step`, `text`,
   * `reset`, then `done` (the final `{ content, activity }`) or `error`.
   */
  @Post('chat/stream')
  @HttpCode(200)
  async chatStream(
    @Auth() auth: AuthInfo,
    @Ctx() ctx: WorkspaceContext,
    @Body() dto: ChatDto,
    @Res() response: Response,
  ) {
    const userId = this.sessionUser(auth);
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once('close', close);
    try {
      await this.ai.run(userId, async () => {
        response.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        const send = (event: string, data: unknown) => {
          if (!response.writableEnded)
            response.write(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            );
        };
        const heartbeat = setInterval(() => {
          if (!response.writableEnded) response.write(': ping\n\n');
        }, 15_000);
        const sink: ChatSink = {
          step: (index, step) => send('step', { index, step }),
          working: (label) => send('working', { label }),
          text: (delta) => send('text', { delta }),
          textReset: () => send('reset', {}),
        };
        try {
          send(
            'done',
            await this.ai.chat(userId, ctx, dto, controller.signal, sink),
          );
        } catch (error) {
          send('error', {
            message:
              error instanceof HttpException
                ? error.message
                : 'The assistant could not finish this reply.',
          });
        } finally {
          clearInterval(heartbeat);
          response.end();
        }
      });
    } finally {
      response.off('close', close);
    }
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
