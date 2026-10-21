import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { Auth, Ctx, RequireUser, type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { SNAPSHOT_COMMENTS_MODES, type SnapshotCommentsMode } from '../contracts/domain.js';
import { SnapshotService } from './snapshot.service.js';

export class SnapshotQuery {
  /** `full` inlines every comment; `index` is the bounded default (see SnapshotCommentsMode). */
  @IsOptional() @IsIn(SNAPSHOT_COMMENTS_MODES) comments?: SnapshotCommentsMode;
}

@Controller('w/:slug/snapshot')
export class SnapshotController {
  constructor(private readonly service: SnapshotService) {}

  /** `WorkspaceSnapshot` (contracts/domain.ts): everything needed to boot a workspace in one call. */
  @Get()
  @RequireUser()
  get(@Ctx() ctx: WorkspaceContext, @Auth() auth: AuthInfo, @Query() q: SnapshotQuery) {
    return this.service.build(ctx, auth.user!, ctx.role, { comments: q.comments ?? 'index' });
  }
}
