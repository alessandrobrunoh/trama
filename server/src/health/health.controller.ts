import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../auth/request-context.js';

@Controller('health')
export class HealthController {
  constructor(private readonly ds: DataSource) {}

  /** Liveness + DB check (Docker healthcheck). */
  @Public()
  @Get()
  async check() {
    try {
      await this.ds.query('SELECT 1');
      return { status: 'ok', db: 'up', time: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
