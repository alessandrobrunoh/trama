import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DecisionsModule } from '../decisions/decisions.module.js';
import { IssueEntity } from '../database/entities/index.js';
import { InputRequestsModule } from '../input-requests/input-requests.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { LunagestModule } from '../lunagest/lunagest.module.js';
import { IssuesController } from './issues.controller.js';
import { IssuesService } from './issues.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([IssueEntity]),
    ArtifactsModule,
    DecisionsModule,
    InputRequestsModule,
    CustomersModule,
    UploadsModule,
    LunagestModule,
  ],
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
