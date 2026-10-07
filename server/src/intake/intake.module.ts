import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntakeItemEntity } from '../database/entities/index.js';
import { WorkstreamsModule } from '../workstreams/workstreams.module.js';
import { IntakeController } from './intake.controller.js';
import { IntakeService } from './intake.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([IntakeItemEntity]), WorkstreamsModule],
  controllers: [IntakeController],
  providers: [IntakeService],
  exports: [IntakeService],
})
export class IntakeModule {}
