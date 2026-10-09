import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from '../customers/customers.module.js';
import { IssueEntity } from '../database/entities/index.js';
import { WorkstreamsModule } from '../workstreams/workstreams.module.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([IssueEntity]), WorkstreamsModule, CustomersModule],
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
