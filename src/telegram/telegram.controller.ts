import { Controller, Post, Get, Delete, Req, UseGuards } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';

@Controller('telegram')
@UseGuards(JwtAuthGuard)
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('link')
  generateLinkCode(@Req() req: any) {
    return this.telegramService.generateLinkCode(req.user.id);
  }

  @Get('status')
  getLinkStatus(@Req() req: any) {
    return this.telegramService.getLinkStatus(req.user.id);
  }

  @Delete('link')
  unlinkTelegram(@Req() req: any) {
    return this.telegramService.unlinkTelegram(req.user.id);
  }
}
