import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { PushService } from './push.service';

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Get(':id/push-status')
  getStatus(@Param('id') userId: string) {
    return this.pushService.getStatus(userId);
  }

  @Get('vapid-key')
  getVapidPublicKey() {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
    };
  }

  @Post(':id/subscribe-push')
  subscribe(@Param('id') userId: string, @Body() body: { subscription: any; userAgent: string }) {
    return this.pushService.saveSubscription(userId, body.subscription, body.userAgent);
  }

  @Post(':id/unsubscribe-push')
  unsubscribe(@Param('id') userId: string) {
    return this.pushService.removeSubscription(userId);
  }

  @Post('send')
  async sendNotification(@Body() body: { userId: string; title: string; body: string }) {
    return this.pushService.sendToUser(body.userId, {
      title: body.title,
      body: body.body,
    });
  }
}
