import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { ViewsModule } from '../views/views.module.js';
import { SnapshotController } from './snapshot.controller.js';
import { SnapshotService } from './snapshot.service.js';

@Module({
  imports: [ViewsModule, AttentionModule, CustomersModule],
  controllers: [SnapshotController],
  providers: [SnapshotService],
})
export class SnapshotModule {}
