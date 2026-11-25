import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { ProjectSharingService } from './project-sharing.service.js';

class InviteToProjectDto {
  @IsEmail() email: string;
}

/**
 * Share one project: invite people to it as guests, list who can open it, take the project away from a guest.
 * Needs the `inviteToProject` capability (owner, admin and organizer by default) and access to the project itself.
 */
@Controller('w/:slug/projects/:id')
@Can('inviteToProject')
export class ProjectSharingController {
  constructor(private readonly service: ProjectSharingService) {}

  /** `ProjectShare`: the people with access and the pending invitations of this project. */
  @Get('share')
  share(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.share(ctx, id);
  }

  /** `ProjectInviteResult`: an invitation (with its link), or an existing guest who now also sees this project. */
  @Post('invites')
  invite(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: InviteToProjectDto) {
    return this.service.invite(ctx, id, dto.email);
  }

  @Post('invites/:inviteId/resend')
  @HttpCode(200)
  resend(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Param('inviteId') inviteId: string) {
    return this.service.resend(ctx, id, inviteId);
  }

  @Delete('invites/:inviteId')
  @HttpCode(204)
  revokeInvite(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Param('inviteId') inviteId: string) {
    return this.service.revokeInvite(ctx, id, inviteId);
  }

  /** Takes this project away from a guest or limited member. `{ membershipEnded }` is true when it was a guest's last project. */
  @Delete('share/:membershipId')
  @HttpCode(200)
  removeAccess(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Param('membershipId') membershipId: string) {
    return this.service.removeAccess(ctx, id, membershipId);
  }
}
