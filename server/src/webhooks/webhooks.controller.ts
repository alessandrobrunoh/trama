import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { GitProvider } from '../contracts/domain.js';
import { Public } from '../auth/request-context.js';
import type { RawBodyRequest } from './raw-body.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Provider webhooks. Public (no session/token): authenticity is the HMAC signature
 * (GitHub, Bitbucket) or secret token (GitLab) of the connection, checked in the service.
 */
@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}

  private async run(provider: GitProvider, connectionId: string, req: Request, res: Response) {
    const result = await this.service.handle({
      provider,
      connectionId,
      rawBody: (req as unknown as RawBodyRequest).rawBody,
      payload: req.body as unknown,
      headers: req.headers,
    });
    res.status(result.httpStatus).json(result.body);
  }

  @Post('github/:connectionId')
  @HttpCode(200)
  github(@Param('connectionId') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run('github', id, req, res);
  }

  @Post('gitlab/:connectionId')
  @HttpCode(200)
  gitlab(@Param('connectionId') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run('gitlab', id, req, res);
  }

  @Post('bitbucket/:connectionId')
  @HttpCode(200)
  bitbucket(@Param('connectionId') id: string, @Req() req: Request, @Res() res: Response) {
    return this.run('bitbucket', id, req, res);
  }
}
