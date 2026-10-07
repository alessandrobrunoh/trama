import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { Public } from '../auth/request-context.js';
import { SeedService } from './seed/seed.service.js';

/** Dev-only helpers; every route 404s when NODE_ENV=production. */
@Controller('admin')
export class AdminController {
  constructor(private readonly seed: SeedService) {}

  /** Wipes ALL data and re-seeds the demo workspace ("Acme", demo@nabla.dev / nabla-demo). */
  @Public()
  @Post('reset')
  @HttpCode(200)
  async reset() {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
    await this.seed.reset();
    return { ok: true };
  }
}
