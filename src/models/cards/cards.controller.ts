import { Body, Controller, Get, Param, Post, Patch, Delete } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CreateCard } from '@/types/models/cards';

@Controller('balances')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  getCards() {
    return this.cardsService.getCards();
  }

  @Get(':id')
  getCard(@Param('id') id: string) {
    return this.cardsService.getCard(Number(id));
  }

  @Post()
  addCard(@Body() card: CreateCard) {
    return this.cardsService.addCard(card);
  }

  @Patch(':id')
  updateCard(@Param('id') id: string, @Body() card: Partial<CreateCard>) {
    return this.cardsService.updateCard(Number(id), card);
  }

  @Delete(':id')
  deleteCard(@Param('id') id: string) {
    return this.cardsService.deleteCard(Number(id));
  }
}
