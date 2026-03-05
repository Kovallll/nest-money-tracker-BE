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
  Req,
} from '@nestjs/common';
import { CardsService } from './cards.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateCardDto, UpdateCardDto } from './dto';

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
    return this.cardsService.getCard(id);
  }

  @Post()
  addCard(@Body() dto: CreateCardDto) {
    return this.cardsService.addCard(dto);
  }

  /** Set this card as the primary one for the current user (used for automatic transactions). */
  @Patch(':id/set-primary')
  setPrimaryCard(
    @Param('id') id: string,
    @Req() req: { user: { id: string } },
  ) {
    const numId = this.cardsService.parseCardId(id);
    return this.cardsService.setPrimaryCard(numId, req.user.id);
  }

  @Patch(':id')
  updateCard(@Param('id') id: string, @Body() dto: UpdateCardDto) {
    return this.cardsService.updateCard(id, dto);
  }

  @Delete(':id')
  deleteCard(@Param('id') id: string) {
    return this.cardsService.deleteCard(id);
  }
}
