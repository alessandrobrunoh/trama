import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalIdentitiesController } from './external-identities.controller.js';
import { ExternalIdentitiesService } from './external-identities.service.js';
import { ExternalIdentityEntity } from './external-identity.entity.js';

/**
 * A person's logins in other tools, and the one resolver that maps a login back to them.
 * Import this module and inject `ExternalIdentitiesService` to use it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ExternalIdentityEntity])],
  controllers: [ExternalIdentitiesController],
  providers: [ExternalIdentitiesService],
  exports: [ExternalIdentitiesService],
})
export class ExternalIdentitiesModule {}
