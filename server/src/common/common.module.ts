import { Global, Module } from '@nestjs/common';
import { CountersService } from './counters.service.js';
import { RefsService } from './refs.service.js';

@Global()
@Module({
  providers: [CountersService, RefsService],
  exports: [CountersService, RefsService],
})
export class CommonModule {}
