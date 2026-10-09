import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  Actor,
  Auth,
  Can,
  Ctx,
  canDo,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import type { ActorRef, DecisionStatus } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { DecisionsService } from './decisions.service.js';

const STATUSES: DecisionStatus[] = [
  'draft',
  'proposed',
  'accepted',
  'superseded',
  'rejected',
];

class CreateDecisionDto {
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @ValidateIf((dto: CreateDecisionDto) => dto.status !== 'draft')
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  statement?: string;
  @IsOptional() @IsString() @MaxLength(20000) rationale?: string;
  /** `proposed` (default) or, for people only, `accepted` / `rejected`. */
  @IsOptional()
  @IsIn(['draft', 'proposed', 'accepted', 'rejected'])
  status?: DecisionStatus;
  @IsOptional() @IsString() originWorkstreamId?: string;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  relatedWorkstreamIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class UpdateDecisionDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  statement?: string;
  @IsOptional() @IsIn(['proposed']) status?: DecisionStatus;
  @Clearable() @IsString() @MaxLength(20000) rationale?: string | null;
  @Clearable() @IsString() originWorkstreamId?: string | null;
  @OptionalNotNull()
  @IsArray()
  @IsString({ each: true })
  relatedWorkstreamIds?: string[];
  @OptionalNotNull() @IsArray() @IsString({ each: true }) tags?: string[];
}

class SupersedeDto {
  /** Id or key (ADR-n) of the decision that replaces this one. */
  @IsString() byId: string;
}

class ListDecisionsQuery {
  @IsOptional() @IsIn(STATUSES) status?: DecisionStatus;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('w/:slug/decisions')
export class DecisionsController {
  constructor(private readonly service: DecisionsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListDecisionsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  create(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Auth() auth: AuthInfo,
    @Body() dto: CreateDecisionDto,
  ) {
    // Creating an already decided record is an accept/reject: same capability as /accept and /reject.
    if (dto.status === 'accepted' || dto.status === 'rejected') {
      if (!canDo(ctx, 'acceptDecisions'))
        throw new ForbiddenException('You are not allowed to accept or reject decisions');
      if (auth.token?.scope === 'custom' && !auth.token.permissions?.includes('decisions:accept'))
        throw new ForbiddenException('This API token lacks the "decisions:accept" permission');
    }
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: UpdateDecisionDto,
  ) {
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Post(':idOrKey/accept')
  @Can('acceptDecisions')
  @HttpCode(200)
  accept(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
  ) {
    return this.service.accept(ctx.workspace.id, actor, idOrKey);
  }

  @Post(':idOrKey/reject')
  @Can('acceptDecisions')
  @HttpCode(200)
  reject(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
  ) {
    return this.service.reject(ctx.workspace.id, actor, idOrKey);
  }

  @Post(':idOrKey/supersede')
  @Can('acceptDecisions')
  @HttpCode(200)
  supersede(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: SupersedeDto,
  ) {
    return this.service.supersede(ctx.workspace.id, actor, idOrKey, dto.byId);
  }

  @Delete(':idOrKey')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
  ) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }
}
