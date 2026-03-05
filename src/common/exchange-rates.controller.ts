import { Controller, Get } from '@nestjs/common';
import { Public } from '@/common/decorators';
import { ExchangeRatesService } from './exchange-rates.service';

export interface ExchangeRatesResponse {
  rateToByn: Record<string, number>;
  date: string;
}

@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly exchangeRates: ExchangeRatesService) {}

  @Get()
  @Public()
  async getRates(): Promise<ExchangeRatesResponse> {
    await this.exchangeRates.loadRates();
    return {
      rateToByn: this.exchangeRates.getRateToByn(),
      date: this.exchangeRates.getCacheDate(),
    };
  }
}
