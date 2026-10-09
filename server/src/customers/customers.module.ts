import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomerEntity, CustomerRequestEntity } from '../database/entities/index.js';
import { CustomerRequestsController, CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([CustomerEntity, CustomerRequestEntity])],
  controllers: [CustomersController, CustomerRequestsController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
