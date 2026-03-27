import {
  Controller,
  Post,
  Get,
  Delete,
  UseGuards,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
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

  @Get('user-context/:telegramUserId')
  async getUserContext(@Param('telegramUserId') telegramUserId: string) {
    try {
      return await this.telegramService.getUserContextByTelegramId(Number(telegramUserId));
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        const response = error.getResponse() as { message?: string } | string;
        const message =
          typeof response === 'string'
            ? response
            : response?.message || 'Ваш Telegram не привязан к аккаунту.';
        return {
          linked: false,
          message,
          telegramUserId: Number(telegramUserId),
        };
      }
      throw error;
    }
  }
}

