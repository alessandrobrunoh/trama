import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentEntity,
  ApiTokenEntity,
  DomainEventEntity,
  MembershipEntity,
  SessionEntity,
} from '../database/entities/index.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { StreamAuthService } from './stream-auth.js';
import { WorkstreamBus } from './workstream-bus.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DomainEventEntity, SessionEntity, ApiTokenEntity, MembershipEntity, AgentEntity])],
  controllers: [EventsController],
  providers: [EventsService, WorkstreamBus, StreamAuthService],
  exports: [EventsService, WorkstreamBus],
})
export class EventsModule {}
