import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactEntity, UploadEntity } from '../database/entities/index.js';
import { UploadExceptionFilter } from './upload-exception.filter.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([UploadEntity, ArtifactEntity])],
  controllers: [UploadsController],
  providers: [UploadsService, UploadExceptionFilter],
  exports: [UploadsService],
})
export class UploadsModule {}
