import { Module } from '@nestjs/common';
import { AttentionController } from './attention.controller.js';
import { AttentionService } from './attention.service.js';

@Module({
  controllers: [AttentionController],
  providers: [AttentionService],
  exports: [AttentionService],
})
export class AttentionModule {}
