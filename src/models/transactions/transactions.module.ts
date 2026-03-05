import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ExchangeRatesController } from '@/common/exchange-rates.controller';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  providers: [TransactionsService, ExchangeRatesService],
  controllers: [TransactionsController, ExchangeRatesController],
  exports: [TransactionsService],
})
export class TransactionsModule {}
