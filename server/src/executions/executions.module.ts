import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutionEntity } from '../database/entities/index.js';
import { DependenciesModule } from '../dependencies/dependencies.module.js';
import { ExecutionsController } from './executions.controller.js';
import { ExecutionsService } from './executions.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ExecutionEntity]), DependenciesModule],
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
  exports: [ExecutionsService],
})
export class ExecutionsModule {}
