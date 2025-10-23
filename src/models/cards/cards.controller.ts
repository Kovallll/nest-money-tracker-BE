import { Controller, Get } from '@nestjs/common';
import { CardsService } from './cards.service';

@Controller('balances')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  getCards() {
    return this.cardsService.getCards();
  }

  @Get('id')
  getCard(id: number) {}
}
