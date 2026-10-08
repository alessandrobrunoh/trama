import { Module } from '@nestjs/common';
import { NotificationSettingsController, NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController, NotificationSettingsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
