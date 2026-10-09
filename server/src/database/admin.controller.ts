import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { Public } from '../auth/request-context.js';
import { adminResetEnabled } from './admin-reset.js';
import { SeedService } from './seed/seed.service.js';

/** Dev/test-only helpers; every route 404s unless TRAMA_ENABLE_ADMIN_RESET=true, and always under NODE_ENV=production. */
@Controller('admin')
export class AdminController {
  constructor(private readonly seed: SeedService) {}

  /** Wipes ALL data and re-seeds the demo workspace ("Acme", demo@nabla.dev / nabla-demo). */
  @Public()
  @Post('reset')
  @HttpCode(200)
  async reset() {
    if (!adminResetEnabled()) throw new NotFoundException();
    await this.seed.reset();
    return { ok: true };
  }
}
