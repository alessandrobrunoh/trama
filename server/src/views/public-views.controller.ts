import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../auth/request-context.js';
import { PublicViewsService } from './public-views.service.js';

/**
 * `GET /api/public/views/:token`: the one unauthenticated door into a saved view. Read-only by
 * construction: the only input is the secret token, and it takes no query string or body, so a
 * visitor cannot influence which rows, fields or workspace are returned.
 */
@Controller('public/views')
export class PublicViewsController {
  constructor(private readonly service: PublicViewsService) {}

  @Get(':token')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  get(@Param('token') token: string) {
    return this.service.get(token);
  }
}
