import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentEntity,
  ApiTokenEntity,
  DomainEventEntity,
  MembershipEntity,
  SessionEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { EventsController } from './events.controller.js';
import { EventVisibilityService } from './event-visibility.service.js';
import { EventsService } from './events.service.js';
import { StreamAuthService } from './stream-auth.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DomainEventEntity,
      SessionEntity,
      ApiTokenEntity,
      MembershipEntity,
      AgentEntity,
      WorkspaceEntity,
    ]),
  ],
  controllers: [EventsController],
  providers: [EventsService, EventVisibilityService, StreamAuthService],
  exports: [EventsService, EventVisibilityService],
})
export class EventsModule {}
