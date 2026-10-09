import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedViewEntity } from '../database/entities/index.js';
import { PublicViewsController } from './public-views.controller.js';
import { PublicViewsService } from './public-views.service.js';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([SavedViewEntity])],
  controllers: [ViewsController, PublicViewsController],
  providers: [ViewsService, PublicViewsService],
  exports: [ViewsService],
})
export class ViewsModule {}
