import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedViewEntity } from '../database/entities/index.js';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([SavedViewEntity])],
  controllers: [ViewsController],
  providers: [ViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
