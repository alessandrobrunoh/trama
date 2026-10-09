import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsEmail, IsIn } from 'class-validator';
import type { Role } from '../contracts/domain.js';
import {
  Auth,
  Can,
  Ctx,
  Public,
  RequireUser,
  SessionOnly,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { InvitesService } from './invites.service.js';

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

class CreateInviteDto {
  @IsEmail() email: string;
  @IsIn(ROLES) role: Role;
}

/** Managing a workspace's invitations (same permission as adding members). */
@Controller('w/:slug/invites')
export class WorkspaceInvitesController {
  constructor(private readonly service: InvitesService) {}

  @Get()
  @Can('inviteMembers')
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id);
  }

  @Post()
  @Can('inviteMembers')
  create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateInviteDto) {
    return this.service.create(ctx.workspace, { userId: ctx.userId, role: ctx.role }, dto);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @Can('inviteMembers')
  resend(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.resend(ctx.workspace, ctx.role, id);
  }

  @Delete(':id')
  @Can('inviteMembers')
  @HttpCode(204)
  revoke(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.revoke(ctx.workspace.id, id);
  }
}

/** What an invitation link points at: viewable by anyone holding the link, accepted by a signed-in user. */
@Controller('invites')
export class InviteLinksController {
  constructor(private readonly service: InvitesService) {}

  @Get(':token')
  @Public()
  preview(@Param('token') token: string) {
    return this.service.preview(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  @RequireUser()
  @SessionOnly()
  accept(@Param('token') token: string, @Auth() auth: AuthInfo) {
    return this.service.accept(token, auth.user!);
  }
}
