import { Controller, Get, Query, UseGuards, Req, BadRequestException } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { RoomMembershipService } from '@/common/room-membership.service';

@Controller('statistics')
@UseGuards(JwtAuthGuard)
export class StatisticsController {
  constructor(
    private readonly stats: StatisticsService,
    private readonly roomMembership: RoomMembershipService,
  ) {}

  @Get('categories/line/year')
  getCategoriesLineByYear(
    @Query('year') year?: string,
    @Query('limitToCurrent') limitToCurrent?: 'true' | 'false',
    @Query('top') top?: string,
    @Query('locale') locale?: string,
    @Query('userId') userId?: string,
    @Query('roomId') roomId?: string,
    @Req() req?: any,
  ) {
    const rid = roomId?.trim();
    const uid = userId?.trim();
    if (rid && uid) {
      throw new BadRequestException('Укажите либо userId, либо roomId');
    }
    if (rid) {
      return this.roomMembership.assertRoomMember(rid, req.user.id).then(() =>
        this.stats.getCategoryExpenseLineChartsByYear({
          year: year ? Number(year) : undefined,
          monthsLimitToCurrent: limitToCurrent !== 'false',
          top: top ? Number(top) : undefined,
          locale,
          roomId: rid,
        }),
      );
    }
    if (uid) {
      this.roomMembership.assertPersonalAccess(uid, req.user.id, req.user?.isService);
    }
    return this.stats.getCategoryExpenseLineChartsByYear({
      year: year ? Number(year) : undefined,
      monthsLimitToCurrent: limitToCurrent !== 'false',
      top: top ? Number(top) : undefined,
      locale,
      userId: uid,
    });
  }

  @Get('expenses/overview')
  getExpensesOverview(
    @Query('monthsBar') monthsBar?: string,
    @Query('topK') topK?: string,
    @Query('locale') locale?: string,
    @Query('piePeriod') piePeriod?: string,
    @Query('userId') userId?: string,
    @Query('roomId') roomId?: string,
    @Req() req?: any,
  ) {
    const rid = roomId?.trim();
    const uid = userId?.trim();
    if (rid && uid) {
      throw new BadRequestException('Укажите либо userId, либо roomId');
    }
    if (rid) {
      return this.roomMembership.assertRoomMember(rid, req.user.id).then(() =>
        this.stats.getExpensesOverview({
          monthsBar: monthsBar ? Number(monthsBar) : undefined,
          topK: topK ? Number(topK) : undefined,
          locale,
          piePeriod,
          roomId: rid,
        }),
      );
    }
    if (uid) {
      this.roomMembership.assertPersonalAccess(uid, req.user.id, req.user?.isService);
    }
    return this.stats.getExpensesOverview({
      monthsBar: monthsBar ? Number(monthsBar) : undefined,
      topK: topK ? Number(topK) : undefined,
      locale,
      piePeriod,
      userId: uid,
    });
  }
}
