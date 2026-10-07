import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DependencyEntity } from '../database/entities/index.js';
import { DependenciesController } from './dependencies.controller.js';
import { DependenciesService } from './dependencies.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([DependencyEntity])],
  controllers: [DependenciesController],
  providers: [DependenciesService],
  exports: [DependenciesService],
})
export class DependenciesModule {}
