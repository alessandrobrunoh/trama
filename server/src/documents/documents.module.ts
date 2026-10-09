import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
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
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
