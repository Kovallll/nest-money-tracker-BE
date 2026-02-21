import { Body, Controller, Get, Param, Post, Patch, Delete, UseGuards } from '@nestjs/common';
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
    return this.cardsService.getCardsByUserId(userId);
  }

  @Get(':id')
  getCard(@Param('id') id: string) {
    return this.cardsService.getCard(Number(id));
  }

  @Post()
  addCard(@Body() dto: CreateCardDto) {
    return this.cardsService.addCard(dto);
  }

  @Patch(':id')
  updateCard(@Param('id') id: string, @Body() dto: UpdateCardDto) {
    return this.cardsService.updateCard(Number(id), dto);
  }

  @Delete(':id')
  deleteCard(@Param('id') id: string) {
    return this.cardsService.deleteCard(Number(id));
  }
}

