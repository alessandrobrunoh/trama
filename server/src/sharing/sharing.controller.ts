import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Auth, RequireUser, SessionOnly, type AuthInfo } from '../auth/request-context.js';
import { SharingService } from './sharing.service.js';

class PlaceProjectDto {
  /** The workspace to show the project in, or `null` to hide it from Shared with me. */
  @ValidateIf((_obj: object, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  workspaceId: string | null;

  @IsOptional() @IsInt() @Min(0) @Max(100_000) position?: number;
}

/**
 * Account-level and personal: every route acts on the caller's own rows and needs a browser session
 * (an API token belongs to one workspace and cannot see across them).
 */
@Controller('shared')
@RequireUser()
@SessionOnly()
export class SharingController {
  constructor(private readonly service: SharingService) {}

  /** Projects shared with me, from every workspace where I am a guest. */
  @Get('projects')
  list(@Auth() auth: AuthInfo) {
    return this.service.list(auth.user!.id);
  }

  /** Show in a workspace of mine (`workspaceId`), or hide from Shared with me (`null`). */
  @Put('projects/:projectId/placement')
  place(@Auth() auth: AuthInfo, @Param('projectId') projectId: string, @Body() dto: PlaceProjectDto) {
    return dto.workspaceId === null
      ? this.service.hide(auth.user!.id, projectId)
      : this.service.place(auth.user!.id, projectId, dto.workspaceId, dto.position);
  }

  /** Back to Shared with me. */
  @Delete('projects/:projectId/placement')
  @HttpCode(204)
  clear(@Auth() auth: AuthInfo, @Param('projectId') projectId: string) {
    return this.service.clear(auth.user!.id, projectId);
  }

  /** Give up my access to the project. */
  @Post('projects/:projectId/leave')
  @HttpCode(204)
  leave(@Auth() auth: AuthInfo, @Param('projectId') projectId: string) {
    return this.service.leave(auth.user!.id, projectId);
  }
}
