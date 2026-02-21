import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';

@Controller('statistics')
@UseGuards(JwtAuthGuard)
export class StatisticsController {
  constructor(private readonly stats: StatisticsService) {}

  @Get('categories/line/year')
  getCategoriesLineByYear(
    @Query('year') year?: string,
    @Query('limitToCurrent') limitToCurrent?: 'true' | 'false',
    @Query('top') top?: string,
    @Query('locale') locale?: string,
    @Query('userId') userId?: string,
  ) {
    return this.stats.getCategoryExpenseLineChartsByYear({
      year: year ? Number(year) : undefined,
      monthsLimitToCurrent: limitToCurrent !== 'false',
      top: top ? Number(top) : undefined,
      locale,
      userId,
    });
  }

  @Get('expenses/overview')
  getExpensesOverview(
    @Query('monthsBar') monthsBar?: string,
    @Query('topK') topK?: string,
    @Query('locale') locale?: string,
    @Query('userId') userId?: string,
  ) {
    return this.stats.getExpensesOverview({
      monthsBar: monthsBar ? Number(monthsBar) : undefined,
      topK: topK ? Number(topK) : undefined,
      locale,
      userId,
    });
  }
}

