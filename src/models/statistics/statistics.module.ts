import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { StatisticsService } from './statistics.service';
import { StatisticsController } from './statistics.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  controllers: [StatisticsController],
  providers: [StatisticsService, ExchangeRatesService],
  exports: [StatisticsService],
})
export class StatisticsModule {}

