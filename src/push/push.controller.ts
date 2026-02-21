import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { PushService } from './push.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { Public } from '@/common/decorators';
import { SubscribePushDto, SendNotificationDto } from './dto';

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Get('vapid-key')
  @Public()
  getVapidPublicKey() {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
    };
  }

  @Get(':id/push-status')
  @UseGuards(JwtAuthGuard)
  getStatus(@Param('id') userId: string) {
    return this.pushService.getStatus(userId);
  }

  @Post(':id/subscribe-push')
  @UseGuards(JwtAuthGuard)
  subscribe(@Param('id') userId: string, @Body() body: SubscribePushDto) {
    return this.pushService.saveSubscription(
      userId,
      body.subscription,
      body.userAgent ?? '',
    );
  }

  @Post(':id/unsubscribe-push')
  @UseGuards(JwtAuthGuard)
  unsubscribe(@Param('id') userId: string) {
    return this.pushService.removeSubscription(userId);
  }

  @Post('send')
  @UseGuards(JwtAuthGuard)
  async sendNotification(@Body() body: SendNotificationDto) {
    return this.pushService.sendToUser(body.userId, {
      title: body.title,
      body: body.body,
    });
  }
}
