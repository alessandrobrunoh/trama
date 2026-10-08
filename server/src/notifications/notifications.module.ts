import { Module } from '@nestjs/common';
import { NotificationSettingsController, NotificationsController, PushController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PushService } from './push.service.js';

@Module({
  controllers: [NotificationsController, NotificationSettingsController, PushController],
  providers: [NotificationsService, PushService],
})
export class NotificationsModule {}
