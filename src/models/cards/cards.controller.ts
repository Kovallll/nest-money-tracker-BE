import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Delete,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { CardsService } from './cards.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateCardDto, UpdateCardDto } from './dto';

function parseCardId(id: string): number {
  const num = Number(id);
  if (Number.isNaN(num) || !Number.isInteger(num) || num < 1) {
    throw new BadRequestException(
      `Некорректный id карты: ожидается целое число больше 0. Передано: "${id}". Для списка карт пользователя используйте GET /api/balances/user/:userId`,
    );
  }
  return num;
}

@Controller('balances')
@UseGuards(JwtAuthGuard)
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  getCards() {
    return this.cardsService.getCards();
  }

  @Get('user/:userId')
  getCardsByUserId(@Param('userId') userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException(
        'Укажите userId в пути: GET /api/balances/user/:userId (например, UUID пользователя).',
      );
    }
    return this.cardsService.getCardsByUserId(userId.trim());
  }

  @Get(':id')
  getCard(@Param('id') id: string) {
    return this.cardsService.getCard(parseCardId(id));
  }

  @Post()
  addCard(@Body() dto: CreateCardDto) {
    return this.cardsService.addCard(dto);
  }

  @Patch(':id')
  updateCard(@Param('id') id: string, @Body() dto: UpdateCardDto) {
    return this.cardsService.updateCard(parseCardId(id), dto);
  }

  @Delete(':id')
  deleteCard(@Param('id') id: string) {
    return this.cardsService.deleteCard(parseCardId(id));
  }
}

