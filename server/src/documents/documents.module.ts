import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import {
  DocumentEntity,
  DocumentRevisionEntity,
} from '../database/entities/index.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentEntity, DocumentRevisionEntity]),
    ArtifactsModule,
    UploadsModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
