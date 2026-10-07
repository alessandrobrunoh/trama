import { MiddlewareConsumer, type NestModule } from '@nestjs/common';
export declare class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void;
}
