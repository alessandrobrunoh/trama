import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Auth, RequireUser, type AuthInfo } from '../auth/request-context.js';
import {
  EXTERNAL_IDENTITY_LOGIN_MAX,
  EXTERNAL_IDENTITY_PROVIDERS,
  type ExternalIdentityProvider,
} from '../contracts/domain.js';
import { ExternalIdentitiesService } from './external-identities.service.js';

class AddExternalIdentityDto {
  @IsIn(EXTERNAL_IDENTITY_PROVIDERS) provider: ExternalIdentityProvider;
  @IsOptional() @IsString() @MaxLength(300) host?: string;
  @IsString() @MinLength(1) @MaxLength(EXTERNAL_IDENTITY_LOGIN_MAX + 1) login: string;
}

/**
 * The logins the current person has in other tools. Personal, so agent tokens get 403, and
 * nobody can read or change another person's list.
 */
@Controller('me/external-identities')
@RequireUser()
export class ExternalIdentitiesController {
  constructor(private readonly service: ExternalIdentitiesService) {}

  @Get()
  list(@Auth() auth: AuthInfo) {
    return this.service.list(auth.user!.id);
  }

  @Post()
  add(@Auth() auth: AuthInfo, @Body() dto: AddExternalIdentityDto) {
    return this.service.add(auth.user!.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.service.remove(auth.user!.id, id);
  }
}
