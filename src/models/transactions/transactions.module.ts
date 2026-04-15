import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ExchangeRatesController } from '@/common/exchange-rates.controller';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { CategorizerModule } from '@/categorizer/categorizer.module';
import { AiInsightsModule } from '@/ai-insights/ai-insights.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
    CategorizerModule,
    AiInsightsModule,
  ],
  providers: [TransactionsService, ExchangeRatesService],
  controllers: [TransactionsController, ExchangeRatesController],
  exports: [TransactionsService],
})
export class TransactionsModule {}
