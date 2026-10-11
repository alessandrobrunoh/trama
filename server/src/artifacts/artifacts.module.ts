import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactEntity } from '../database/entities/index.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { ArtifactsController } from './artifacts.controller.js';
import { ArtifactsService } from './artifacts.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ArtifactEntity]), UploadsModule],
  controllers: [ArtifactsController],
  providers: [ArtifactsService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
