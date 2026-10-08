import { Body, Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, Post } from '@nestjs/common';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { Ctx, RequireUser, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { FAVORITE_TYPES, type FavoriteType } from '../contracts/domain.js';
import { FavoritesService } from './favorites.service.js';

class AddFavoriteDto {
  @IsIn(FAVORITE_TYPES) type: FavoriteType;
  @IsString() @MaxLength(100) subjectId: string;
}

/**
 * A person's own favorites. Personal, so agent tokens get 403, and viewers may keep favorites
 * too (they only read the workspace, they do not change it).
 */
@Controller('w/:slug/favorites')
@RequireUser()
export class FavoritesController {
  constructor(private readonly service: FavoritesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id, ctx.userId!);
  }

  @Post()
  @Roles('viewer')
  add(@Ctx() ctx: WorkspaceContext, @Body() dto: AddFavoriteDto) {
    return this.service.add(ctx.workspace.id, ctx.userId!, dto.type, dto.subjectId);
  }

  @Delete(':type/:subjectId')
  @Roles('viewer')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Param('type', new ParseEnumPipe(FAVORITE_TYPES)) type: FavoriteType,
    @Param('subjectId') subjectId: string,
  ) {
    return this.service.remove(ctx.workspace.id, ctx.userId!, type, subjectId);
  }
}
