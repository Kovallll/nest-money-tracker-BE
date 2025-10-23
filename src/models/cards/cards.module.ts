import { Module } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { TransactionsService } from '../transactions/transactions.service';

@Module({
  providers: [CardsService, TransactionsService],
  controllers: [CardsController],
})
export class CardsModule {}
