import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Ctx, RequireUser, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { CustomerSubscriptionsService } from './customer-subscriptions.service.js';

class FollowCustomerDto {
  @IsString() @MinLength(1) @MaxLength(100) customerId: string;
}

/**
 * The signed-in person's own customer subscriptions (the bell on a customer page). Personal, so agent
 * tokens get 403; viewers may follow customers too, since it changes nothing in the workspace.
 */
@Controller('w/:slug/customer-subscriptions')
@RequireUser()
export class CustomerSubscriptionsController {
  constructor(private readonly service: CustomerSubscriptionsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id, ctx.userId!);
  }

  @Post()
  @Roles('viewer')
  add(@Ctx() ctx: WorkspaceContext, @Body() dto: FollowCustomerDto) {
    return this.service.add(ctx.workspace.id, ctx.userId!, dto.customerId);
  }

  @Delete(':customerId')
  @Roles('viewer')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('customerId') customerId: string) {
    return this.service.remove(ctx.workspace.id, ctx.userId!, customerId);
  }
}
