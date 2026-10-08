import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MilestoneEntity } from '../database/entities/index.js';
import { MilestonesController } from './milestones.controller.js';
import { MilestonesService } from './milestones.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([MilestoneEntity])],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
