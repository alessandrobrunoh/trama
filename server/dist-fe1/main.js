import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
if (existsSync('.env'))
    process.loadEnvFile('.env');
async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    configureApp(app);
    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    Logger.log(`Nabla API listening on http://localhost:${port}/api`, 'Bootstrap');
}
await bootstrap();
//# sourceMappingURL=main.js.map