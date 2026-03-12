import { Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AnalyticsSnapshot, AnalyticsSnapshotDocument } from './schemas/analytics-snapshot.schema';
import { StatisticsService } from '../statistics/statistics.service';
import { UsersService } from '@/users/users.service';

export type PeriodType = 'week' | 'month' | 'quarter';

function getLastDayOfMonth(year: number, month: number): Date {
  return new Date(year, month + 1, 0);
}

function getQuarterEnd(year: number, quarter: number): Date {
  const month = quarter * 3; // 0->0, 1->3, 2->6, 3->9
  return new Date(year, month + 3, 0); // last day of quarter month
}

function getWeekEnd(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Get end date of the period that contains the given date */
function getPeriodEnd(periodType: PeriodType, date: Date): Date {
  const d = new Date(date);
  if (periodType === 'week') {
    return getWeekEnd(d);
  }
  if (periodType === 'month') {
    const last = getLastDayOfMonth(d.getFullYear(), d.getMonth());
    last.setHours(23, 59, 59, 999);
    return last;
  }
  // quarter: 0-2 -> Q1, 3-5 -> Q2, 6-8 -> Q3, 9-11 -> Q4
  const month = d.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  const end = getQuarterEnd(d.getFullYear(), quarter);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Get the end date of the period that ended just before the given date */
function getPreviousPeriodEnd(periodType: PeriodType, beforeDate: Date): Date {
  const d = new Date(beforeDate);
  if (periodType === 'week') {
    d.setDate(d.getDate() - 7);
    return getWeekEnd(d);
  }
  if (periodType === 'month') {
    d.setMonth(d.getMonth() - 1);
    const last = getLastDayOfMonth(d.getFullYear(), d.getMonth());
    last.setHours(23, 59, 59, 999);
    return last;
  }
  const month = d.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  const prevQ = quarter === 1 ? 4 : quarter - 1;
  const prevYear = quarter === 1 ? d.getFullYear() - 1 : d.getFullYear();
  const end = getQuarterEnd(prevYear, prevQ);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Get period start from period end */
function getPeriodStart(periodType: PeriodType, periodEnd: Date): Date {
  const e = new Date(periodEnd);
  if (periodType === 'week') {
    const start = new Date(e);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (periodType === 'month') {
    e.setDate(1);
    e.setHours(0, 0, 0, 0);
    return e;
  }
  const month = e.getMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  e.setMonth(quarterStartMonth);
  e.setDate(1);
  e.setHours(0, 0, 0, 0);
  return e;
}

/** Next period end after the given period end */
function getNextPeriodEnd(periodType: PeriodType, afterPeriodEnd: Date): Date {
  const d = new Date(afterPeriodEnd);
  if (periodType === 'week') {
    d.setDate(d.getDate() + 7);
    return getWeekEnd(d);
  }
  if (periodType === 'month') {
    d.setMonth(d.getMonth() + 1);
    const last = getLastDayOfMonth(d.getFullYear(), d.getMonth());
    last.setHours(23, 59, 59, 999);
    return last;
  }
  const month = d.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  const nextQ = quarter === 4 ? 1 : quarter + 1;
  const nextYear = quarter === 4 ? d.getFullYear() + 1 : d.getFullYear();
  const end = getQuarterEnd(nextYear, nextQ);
  end.setHours(23, 59, 59, 999);
  return end;
}

function periodEndToLabel(periodEnd: Date, locale = 'en'): string {
  const d = new Date(periodEnd);
  const month = d.toLocaleString(locale, { month: 'short' });
  const year = d.getFullYear();
  return `${month} ${year}`;
}

@Injectable()
export class AnalyticsSnapshotsService {
  constructor(
    @InjectModel(AnalyticsSnapshot.name)
    private readonly snapshotModel: Model<AnalyticsSnapshotDocument>,
    private readonly statisticsService: StatisticsService,
    private readonly usersService: UsersService,
  ) {}

  async createSnapshot(
    userId: string,
    periodType: PeriodType,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<AnalyticsSnapshotDocument> {
    const overview = await this.statisticsService.getExpensesOverview({
      monthsBar: 6,
      locale: 'en',
      userId,
    });
    const year = new Date(periodEnd).getFullYear();
    const categoryLineCharts = await this.statisticsService.getCategoryExpenseLineChartsByYear({
      year,
      locale: 'en',
      userId,
    });
    const doc = new this.snapshotModel({
      userId,
      periodType,
      periodStart,
      periodEnd,
      overview,
      categoryLineCharts,
    });
    return doc.save();
  }

  async findLastSnapshot(userId: string): Promise<AnalyticsSnapshotDocument | null> {
    return this.snapshotModel
      .findOne({ userId })
      .sort({ periodEnd: -1 })
      .lean()
      .exec() as Promise<AnalyticsSnapshotDocument | null>;
  }

  async list(
    userId: string,
    params: {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      periodType?: PeriodType;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
    },
  ): Promise<{
    items: AnalyticsSnapshotDocument[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const sortBy = params.sortBy ?? 'createdAt';
    const sortOrder = params.sortOrder ?? 'desc';

    const filter: Record<string, unknown> = { userId };

    if (params.periodType) {
      filter.periodType = params.periodType;
    }
    const periodEndFilter: Record<string, Date> = {};
    if (params.dateFrom) {
      periodEndFilter.$gte = new Date(params.dateFrom);
    }
    if (params.dateTo) {
      periodEndFilter.$lte = new Date(params.dateTo);
    }
    if (Object.keys(periodEndFilter).length > 0) {
      filter.periodEnd = periodEndFilter;
    }

    if (params.search && params.search.trim()) {
      const searchLower = params.search.trim().toLowerCase();
      const searchRegex = new RegExp(escapeRegex(searchLower), 'i');
      const candidates = await this.snapshotModel
        .find({ userId })
        .select('_id periodStart periodEnd periodType createdAt')
        .lean()
        .exec();
      const matchingIds = candidates
        .filter((c) => {
          const label = periodEndToLabel(c.periodEnd);
          return searchRegex.test(label) || searchRegex.test(String(c.periodType));
        })
        .map((c) => c._id);
      if (matchingIds.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          limit,
          totalPages: 0,
        };
      }
      filter._id = { $in: matchingIds };
    }

    const total = await this.snapshotModel.countDocuments(filter).exec();
    const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
    const items = await this.snapshotModel
      .find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();

    return {
      items: items as unknown as AnalyticsSnapshotDocument[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(id: string, userId: string): Promise<AnalyticsSnapshotDocument> {
    const doc = await this.snapshotModel.findOne({ _id: id, userId }).lean().exec();
    if (!doc) {
      throw new NotFoundException('Snapshot not found');
    }
    return doc as unknown as AnalyticsSnapshotDocument;
  }

  @Cron('0 2 * * *') // Every day at 02:00
  async handleScheduledSnapshots(): Promise<void> {
    await this.runScheduledSnapshots();
  }

  async runScheduledSnapshots(): Promise<{ created: number }> {
    const users = await this.usersService.getUsersWithAnalyticsSnapshotsEnabled();
    const now = new Date();
    let created = 0;

    for (const user of users) {
      const periodType = (user.analytics_snapshot_periodicity || 'month') as PeriodType;
      if (!['week', 'month', 'quarter'].includes(periodType)) continue;

      let last = await this.findLastSnapshot(user.id);
      let nextPeriodEnd: Date;
      if (!last) {
        nextPeriodEnd = getPreviousPeriodEnd(periodType, now);
      } else {
        nextPeriodEnd = getNextPeriodEnd(periodType, last.periodEnd);
      }

      while (nextPeriodEnd < now) {
        const periodStart = getPeriodStart(periodType, nextPeriodEnd);
        await this.createSnapshot(user.id, periodType, periodStart, nextPeriodEnd);
        created++;
        nextPeriodEnd = getNextPeriodEnd(periodType, nextPeriodEnd);
      }
    }

    return { created };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

