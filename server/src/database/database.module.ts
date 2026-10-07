import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions, databaseUrl } from './data-source.options.js';
import { ensureDatabase } from './ensure-database.js';
import { AdminController } from './admin.controller.js';
import { SeedService } from './seed/seed.service.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: async () => {
        await ensureDatabase(databaseUrl());
        return dataSourceOptions();
      },
    }),
  ],
  controllers: [AdminController],
  providers: [SeedService],
  exports: [SeedService],
})
export class DatabaseModule {}
