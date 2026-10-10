import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/request-context.js';
import { demoLoginEnabled } from './public-config.js';

@Controller('config')
export class PublicConfigController {
  /** Unauthenticated settings the sign-in page needs before a session exists. */
  @Public()
  @Get()
  config() {
    return { demoLogin: demoLoginEnabled() };
  }
}
