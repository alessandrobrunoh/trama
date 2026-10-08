import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { Ctx, RequireUser, Roles, Auth, type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { NOTIFICATION_KINDS, type NotificationChannels, type NotificationKind } from '../contracts/domain.js';
import { NotificationsService } from './notifications.service.js';

class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Boolean) @IsBoolean() unread?: boolean;
}

class MarkReadDto {
  /** Omit to mark everything in the workspace as read. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids?: string[];
}

class UpdateSettingsDto {
  @IsObject() settings: Record<string, Record<string, unknown>>;
}

/** The caller's own notifications in a workspace. Personal, so agent tokens get 403. */
@Controller('w/:slug/notifications')
@RequireUser()
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListQuery) {
    return this.service.list(ctx.workspace.id, ctx.userId!, { limit: q.limit, unreadOnly: q.unread });
  }

  @Post('read')
  @HttpCode(200)
  @Roles('viewer')
  read(@Ctx() ctx: WorkspaceContext, @Body() dto: MarkReadDto) {
    return this.service.markRead(ctx.workspace.id, ctx.userId!, dto.ids);
  }
}

/** The signed-in person's notification settings, the same in every workspace. */
@Controller('me/notification-settings')
@RequireUser()
export class NotificationSettingsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  get(@Auth() auth: AuthInfo) {
    return this.service.getSettings(auth.user!.id);
  }

  @Patch()
  update(@Auth() auth: AuthInfo, @Body() dto: UpdateSettingsDto) {
    const patch: Partial<Record<NotificationKind, Partial<NotificationChannels>>> = {};
    for (const [kind, channels] of Object.entries(dto.settings)) {
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`Unknown notification kind "${kind}"`);
      if (!channels || typeof channels !== 'object') throw new BadRequestException(`Settings for "${kind}" must be an object`);
      const entry: Partial<NotificationChannels> = {};
      for (const [channel, value] of Object.entries(channels)) {
        if (channel !== 'inApp' && channel !== 'email') throw new BadRequestException(`Unknown channel "${channel}"`);
        if (typeof value !== 'boolean') throw new BadRequestException(`${kind}.${channel} must be true or false`);
        entry[channel] = value;
      }
      patch[kind as NotificationKind] = entry;
    }
    return this.service.updateSettings(auth.user!.id, patch);
  }
}
