import { Module } from '@nestjs/common';
import { WorkstreamsModule } from '../workstreams/workstreams.module.js';
import { AgentContextController } from './agent-context.controller.js';
import { AgentContextService } from './agent-context.service.js';

@Module({
  imports: [WorkstreamsModule],
  controllers: [AgentContextController],
  providers: [AgentContextService],
  exports: [AgentContextService],
})
export class AgentContextModule {}
