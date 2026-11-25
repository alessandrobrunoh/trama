import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationConnectionEntity } from '../database/entities/index.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { IssuesModule } from '../issues/issues.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { RoutingRuleEntity, RoutingRuleItemEntity } from './entities.js';
import { InboundRoutingService } from './inbound-routing.service.js';
import { RoutingRulesController } from './routing-rules.controller.js';
import { RoutingRulesService } from './routing-rules.service.js';
import { TwoWaySyncService } from './two-way-sync.service.js';

/** Routing rules: which external source sends work to which project, and the two-way sync of the tasks they create. */
@Module({
  imports: [
    TypeOrmModule.forFeature([RoutingRuleEntity, RoutingRuleItemEntity, IntegrationConnectionEntity]),
    IntegrationsModule,
    IssuesModule,
    ProjectsModule,
  ],
  controllers: [RoutingRulesController],
  providers: [RoutingRulesService, InboundRoutingService, TwoWaySyncService],
  exports: [RoutingRulesService, InboundRoutingService, TwoWaySyncService],
})
export class RoutingModule {}
