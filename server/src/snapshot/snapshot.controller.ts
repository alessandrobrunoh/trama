import { Controller, Get } from '@nestjs/common';
import { Auth, Ctx, RequireUser, type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { SnapshotService } from './snapshot.service.js';

@Controller('w/:slug/snapshot')
export class SnapshotController {
  constructor(private readonly service: SnapshotService) {}

  /** `WorkspaceSnapshot` (contracts/domain.ts): everything needed to boot a workspace in one call. */
  @Get()
  @RequireUser()
  get(@Ctx() ctx: WorkspaceContext, @Auth() auth: AuthInfo) {
    return this.service.build(ctx, auth.user!, ctx.role);
  }
}
