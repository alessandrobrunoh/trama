import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ApiTokenEntity,
  MembershipEntity,
  SessionEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokensService } from './tokens.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      SessionEntity,
      MembershipEntity,
      WorkspaceEntity,
      ApiTokenEntity,
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokensService],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
