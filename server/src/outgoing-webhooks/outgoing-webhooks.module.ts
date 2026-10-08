import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutgoingWebhookDeliveryEntity, OutgoingWebhookEntity } from '../database/entities/index.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { OutgoingWebhooksController } from './outgoing-webhooks.controller.js';
import { OutgoingWebhooksService } from './outgoing-webhooks.service.js';

/** Custom integrations: outgoing webhooks fed by the DomainEvent log (EventsService.recorded$). */
@Module({
  imports: [TypeOrmModule.forFeature([OutgoingWebhookEntity, OutgoingWebhookDeliveryEntity]), IntegrationsModule],
  controllers: [OutgoingWebhooksController],
  providers: [OutgoingWebhooksService],
  exports: [OutgoingWebhooksService],
})
export class OutgoingWebhooksModule {}
