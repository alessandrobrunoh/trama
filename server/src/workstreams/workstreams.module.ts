import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkstreamEntity } from '../database/entities/index.js';
import { WorkstreamsController } from './workstreams.controller.js';
import { WorkstreamsService } from './workstreams.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([WorkstreamEntity])],
  controllers: [WorkstreamsController],
  providers: [WorkstreamsService],
  exports: [WorkstreamsService],
})
export class WorkstreamsModule {}
