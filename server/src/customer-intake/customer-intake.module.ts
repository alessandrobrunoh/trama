import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from '../customers/customers.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { CustomerIntakeController, IntakeSourcesController, IntakeWebhookController } from './customer-intake.controller.js';
import { CustomerIntakeService } from './customer-intake.service.js';
import { IntakeItemEntity, IntakeSourceEntity } from './entities.js';

@Module({
  imports: [TypeOrmModule.forFeature([IntakeSourceEntity, IntakeItemEntity]), CustomersModule, IntegrationsModule],
  controllers: [IntakeSourcesController, CustomerIntakeController, IntakeWebhookController],
  providers: [CustomerIntakeService],
})
export class CustomerIntakeModule {}
