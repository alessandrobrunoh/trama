import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DecisionEntity } from '../database/entities/index.js';
import { DecisionsController } from './decisions.controller.js';
import { DecisionsService } from './decisions.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([DecisionEntity])],
  controllers: [DecisionsController],
  providers: [DecisionsService],
  exports: [DecisionsService],
})
export class DecisionsModule {}
