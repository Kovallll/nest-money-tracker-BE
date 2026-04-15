import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiInsightsController } from '@/ai-insights/ai-insights.controller';
import { AiInsightsService } from '@/ai-insights/ai-insights.service';
import { PgModule } from '@/pg/pg.module';
import { CommonModule } from '@/common/common.module';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { AiModule } from '@/ai/ai.module';

@Module({
  imports: [
    PgModule,
    CommonModule,
    AiModule,
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  controllers: [AiInsightsController],
  providers: [AiInsightsService, ExchangeRatesService],
  exports: [AiInsightsService],
})
export class AiInsightsModule {}

