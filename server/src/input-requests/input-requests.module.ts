import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InputRequestEntity } from '../database/entities/index.js';
import { InputRequestsController } from './input-requests.controller.js';
import { InputRequestsService } from './input-requests.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([InputRequestEntity])],
  controllers: [InputRequestsController],
  providers: [InputRequestsService],
  exports: [InputRequestsService],
})
export class InputRequestsModule {}
