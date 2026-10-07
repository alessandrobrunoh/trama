import { Module } from '@nestjs/common';
import { StatusService } from './status.service.js';

@Module({
  providers: [StatusService],
  exports: [StatusService],
})
export class StatusModule {}
