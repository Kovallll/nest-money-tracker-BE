import { Controller, Get, Post, Query, Param, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { AnalyticsSnapshotsService, PeriodType } from './analytics-snapshots.service';

@Controller('analytics-snapshots')
@UseGuards(JwtAuthGuard)
export class AnalyticsSnapshotsController {
  constructor(private readonly snapshotsService: AnalyticsSnapshotsService) {}

  @Get()
  async list(
    @Req() req: { user: { id: string } },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('periodType') periodType?: PeriodType,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('search') search?: string,
  ) {
    const userId = req.user.id;
    return this.snapshotsService.list(userId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      sortBy,
      sortOrder,
      periodType,
      dateFrom,
      dateTo,
      search,
    });
  }

  /** After manual export from the app header: persist current-period snapshot for Saved reports. */
  @Post('from-export')
  async createFromExport(@Req() req: { user: { id: string } }) {
    return this.snapshotsService.createSnapshotFromExport(req.user.id);
  }

  @Get(':id')
  async getById(@Param('id') id: string, @Req() req: { user: { id: string } }) {
    const userId = req.user.id;
    return this.snapshotsService.getById(id, userId);
  }
}
