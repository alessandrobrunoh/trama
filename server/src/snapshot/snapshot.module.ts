import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module.js';
import { ExecutionsModule } from '../executions/executions.module.js';
import { ViewsModule } from '../views/views.module.js';
import { SnapshotController } from './snapshot.controller.js';
import { SnapshotService } from './snapshot.service.js';

@Module({
  imports: [ExecutionsModule, ViewsModule, AttentionModule],
  controllers: [SnapshotController],
  providers: [SnapshotService],
})
export class SnapshotModule {}
