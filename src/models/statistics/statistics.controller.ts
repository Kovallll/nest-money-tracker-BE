// statistics/statistics.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { CategoryLineChartDto, ExpensesOverviewDto } from '@/types';

@Controller('statistics')
export class StatisticsController {
  constructor(private readonly stats: StatisticsService) {}

  @Get('categories/line/year')
  async getCategoriesLineByYear(
    @Query('year') year?: string,
    @Query('limitToCurrent') limitToCurrent?: 'true' | 'false',
    @Query('top') top?: string,
    @Query('locale') locale?: string,
  ) {
    return this.stats.getCategoryExpenseLineChartsByYear({
      year: year ? Number(year) : undefined,
      monthsLimitToCurrent: limitToCurrent !== 'false',
      top: top ? Number(top) : undefined,
      locale,
    });
  }

  @Get('expenses/overview')
  async getExpensesOverview(
    @Query('monthsBar') monthsBar?: string,
    @Query('topK') topK?: string,
    @Query('locale') locale?: string,
  ) {
    return this.stats.getExpensesOverview({
      monthsBar: monthsBar ? Number(monthsBar) : undefined,
      topK: topK ? Number(topK) : undefined,
      locale,
    });
  }
}

