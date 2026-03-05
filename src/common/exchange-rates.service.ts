import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const NBRB_BASE = 'https://api.nbrb.by/exrates';

/** NBRB returns rates in BYN per Cur_Scale units of foreign currency. 1 USD = Cur_OfficialRate/Cur_Scale BYN. */
interface NbrbRateItem {
  Cur_Abbreviation: string;
  Cur_Scale: number;
  Cur_OfficialRate: number;
}

/** Fallback when API fails. 1 unit of key = value BYN (same as frontend). */
const FALLBACK_RATES_TO_BYN: Record<string, number> = {
  BYN: 1,
  USD: 3.27,
  EUR: 3.55,
  RUB: 0.0355,
};

@Injectable()
export class ExchangeRatesService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeRatesService.name);

  private cache: Record<string, Record<string, number>> | null = null;
  private cacheDate = '';
  private loading = false;

  constructor(private readonly httpService: HttpService) {}

  async onModuleInit(): Promise<void> {
    await this.loadRates();
  }

  /**
   * Get exchange rate: 1 unit of fromCode = X units of toCode.
   * Uses NBRB cache or fallback. Returns 1 if same currency or unknown.
   * Triggers background refresh if cache is from a previous day.
   */
  getRate(fromCode: string, toCode: string): number {
    const today = new Date().toISOString().slice(0, 10);
    if (!this.loading && this.cacheDate !== today) {
      this.loadRates().catch(() => {});
    }
    const from = (fromCode || 'BYN').toUpperCase();
    const to = (toCode || 'BYN').toUpperCase();
    if (from === to) return 1;
    const matrix = this.cache ?? this.getFallbackMatrix();
    const rate = matrix[from]?.[to];
    return rate ?? (this.rateToBynFromMatrix(matrix, from) / this.rateToBynFromMatrix(matrix, to));
  }

  /** Convert amount from one currency to another. */
  convert(amount: number, fromCode: string, toCode: string): number {
    return amount * this.getRate(fromCode, toCode);
  }

  /** Load rates from NBRB (api.nbrb.by). Uses fallback on failure. */
  async loadRates(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.cacheDate === today && this.cache) return;
    if (this.loading) return;

    this.loading = true;
    try {
      const url = `${NBRB_BASE}/rates?ondate=${today}&periodicity=0`;
      const { data } = await firstValueFrom(this.httpService.get<NbrbRateItem[]>(url));
      const rateToByn = this.parseNbrbRates(data ?? []);
      this.cache = this.buildMatrixFromRateToByn(rateToByn);
      this.cacheDate = today;
      this.logger.log(`Курсы NBRB загружены на ${today}`);
    } catch (err) {
      this.logger.warn(`NBRB API недоступен, используются запасные курсы: ${(err as Error).message}`);
      this.cache = this.getFallbackMatrix();
      this.cacheDate = today;
    } finally {
      this.loading = false;
    }
  }

  private parseNbrbRates(list: NbrbRateItem[]): Record<string, number> {
    const rateToByn: Record<string, number> = { BYN: 1 };
    for (const item of list) {
      const code = item.Cur_Abbreviation?.toUpperCase();
      if (!code || code === 'BYN') continue;
      const scale = Math.max(1, Number(item.Cur_Scale) || 1);
      rateToByn[code] = Number(item.Cur_OfficialRate) / scale;
    }
    for (const [k, v] of Object.entries(FALLBACK_RATES_TO_BYN)) {
      if (k !== 'BYN' && rateToByn[k] == null) rateToByn[k] = v;
    }
    return rateToByn;
  }

  private buildMatrixFromRateToByn(
    rateToByn: Record<string, number>,
  ): Record<string, Record<string, number>> {
    const all = [
      'BYN',
      'USD',
      'EUR',
      'RUB',
      ...Object.keys(rateToByn).filter((c) => !['BYN', 'USD', 'EUR', 'RUB'].includes(c)),
    ];
    const uniq = [...new Set(all)];
    const matrix: Record<string, Record<string, number>> = {};
    for (const from of uniq) {
      matrix[from] = matrix[from] ?? {};
      const fromPerByn = rateToByn[from] ?? 1;
      for (const to of uniq) {
        const toPerByn = rateToByn[to] ?? 1;
        matrix[from][to] = from === to ? 1 : fromPerByn / toPerByn;
      }
    }
    return matrix;
  }

  private rateToBynFromMatrix(matrix: Record<string, Record<string, number>>, code: string): number {
    return matrix[code]?.['BYN'] ?? FALLBACK_RATES_TO_BYN[code] ?? 1;
  }

  private getFallbackMatrix(): Record<string, Record<string, number>> {
    return this.buildMatrixFromRateToByn(FALLBACK_RATES_TO_BYN);
  }

  /** Current rates to BYN (1 unit of code = X BYN). For API response. */
  getRateToByn(): Record<string, number> {
    const matrix = this.cache ?? this.getFallbackMatrix();
    const rateToByn: Record<string, number> = {};
    for (const code of Object.keys(matrix)) {
      rateToByn[code] = matrix[code]?.['BYN'] ?? FALLBACK_RATES_TO_BYN[code] ?? 1;
    }
    for (const [k, v] of Object.entries(FALLBACK_RATES_TO_BYN)) {
      if (rateToByn[k] == null) rateToByn[k] = v;
    }
    return rateToByn;
  }

  getCacheDate(): string {
    return this.cacheDate;
  }
}
