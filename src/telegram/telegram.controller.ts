import { Controller, Post, Get, Delete, UseGuards } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CurrentUser } from '@/common/decorators';

@Controller('telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('link')
  generateLinkCode(@CurrentUser('id') userId: string) {
    return this.telegramService.generateLinkCode(userId);
  }

  @Get('status')
  getLinkStatus(@CurrentUser('id') userId: string) {
    return this.telegramService.getLinkStatus(userId);
  }

  @Delete('link')
  unlinkTelegram(@CurrentUser('id') userId: string) {
    return this.telegramService.unlinkTelegram(userId);
  }
}
