import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DomainEventEntity } from '../database/entities/index.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { WorkstreamBus } from './workstream-bus.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DomainEventEntity])],
  controllers: [EventsController],
  providers: [EventsService, WorkstreamBus],
  exports: [EventsService, WorkstreamBus],
})
export class EventsModule {}
