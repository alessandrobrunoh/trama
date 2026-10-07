import { Module } from '@nestjs/common';
import { WorkstreamsModule } from '../workstreams/workstreams.module.js';
import { GraphController } from './graph.controller.js';
import { GraphService } from './graph.service.js';

@Module({
  imports: [WorkstreamsModule],
  controllers: [GraphController],
  providers: [GraphService],
})
export class GraphModule {}
