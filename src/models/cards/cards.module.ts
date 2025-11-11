import { Module } from '@nestjs/common';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  providers: [CardsService],
  controllers: [CardsController],
  imports: [TransactionsModule],
})
export class CardsModule {}
