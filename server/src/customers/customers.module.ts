import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerEntity, CustomerRequestEntity } from '../database/entities/index.js';
import { CustomerSubscriptionsController } from './customer-subscriptions.controller.js';
import { CustomerSubscriptionsService } from './customer-subscriptions.service.js';
import { CustomerRequestsController, CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([CustomerEntity, CustomerRequestEntity])],
  controllers: [CustomersController, CustomerRequestsController, CustomerSubscriptionsController],
  providers: [CustomersService, CustomerSubscriptionsService],
  exports: [CustomersService],
})
export class CustomersModule {}
