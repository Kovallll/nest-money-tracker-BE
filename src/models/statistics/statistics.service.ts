import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { GROUP_ROOM_CATEGORY_NAMES } from '@/models/categories/seed';
import { CategoryLineChartDto, ExpensesOverviewDto, StatisticsPiePeriod } from '@/types';

const PIE_PERIOD_VALUES: StatisticsPiePeriod[] = [
  'current_month',
  'last_3',
  'last_6',
  'last_12',
  'all',
];

function normalizePiePeriod(raw?: string): StatisticsPiePeriod {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase() as StatisticsPiePeriod;
  return PIE_PERIOD_VALUES.includes(v) ? v : 'current_month';
}

interface TxRow {
  category_id: string | null;
  date: Date;
  amount: string;
}

@Injectable()
export class StatisticsService {
  private readonly palette = [
    '#4F46E5',
    '#06B6D4',
    '#F59E0B',
    '#10B981',
    '#EF4444',
    '#8B5CF6',
    '#22C55E',
    '#0EA5E9',
    '#E11D48',
    '#84CC16',
    '#A855F7',
    '#F97316',
  ];

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getCategoryExpenseLineChartsByYear(params?: {
    year?: number;
    monthsLimitToCurrent?: boolean;
    top?: number;
    locale?: string;
    userId?: string;
    roomId?: string;
  }): Promise<CategoryLineChartDto[]> {
    const year = params?.year ?? new Date().getFullYear();
    const locale = params?.locale ?? 'en';
    const limitToCurrent = params?.monthsLimitToCurrent ?? true;
    const top = params?.top;
    const userId = params?.userId;
    const roomId = params?.roomId;

    const now = new Date();
    const lastMonthIndex = limitToCurrent && year === now.getFullYear() ? now.getMonth() : 11;

    const labels = Array.from({ length: lastMonthIndex + 1 }, (_, m) =>
      new Date(year, m, 1).toLocaleString(locale, { month: 'short' }),
    );

    const transactions = await this.fetchExpenseTransactions(year, lastMonthIndex, userId, roomId);
    const categories = await this.fetchCategoriesMap(userId, roomId);

    const byCategory = this.groupExpensesByCategoryAndMonth(transactions, year, lastMonthIndex);

    const charts: CategoryLineChartDto[] = [];
    for (const [categoryId, monthly] of byCategory.entries()) {
      const title = categories.get(categoryId) ?? categoryId ?? 'Без категории';
      charts.push({
        categoryId: categoryId ?? '',
        title,
        labels,
        datasets: [
          {
            label: 'Expenses',
            data: monthly.map((v) => +v.toFixed(2)),
            borderColor: this.palette[charts.length % this.palette.length],
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 2,
            fill: false,
          },
        ],
      });
    }

    const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
    const sorted = charts.sort((a, b) => sum(b.datasets[0].data) - sum(a.datasets[0].data));
    return typeof top === 'number' ? sorted.slice(0, top) : sorted;
  }

  async getExpensesOverview(params?: {
    monthsBar?: number;
    topK?: number;
    locale?: string;
    userId?: string;
    roomId?: string;
    /** Период для pie (Categories share). По умолчанию текущий месяц. */
    piePeriod?: string;
  }): Promise<ExpensesOverviewDto> {
    const monthsBar = params?.monthsBar ?? 6;
    const topK = params?.topK; // undefined = все категории
    const locale = params?.locale ?? 'en';
    const userId = params?.userId;
    const roomId = params?.roomId;
    const piePeriod = normalizePiePeriod(params?.piePeriod);

    const now = new Date();
    const year = now.getFullYear();
    const currentMonth = now.getMonth();

    const barMonths = this.buildLastMonths(monthsBar, now);
    const barLabels = barMonths.map((d) => d.toLocaleString(locale, { month: 'short' }));

    const lineMonths = this.buildLastMonths(12, now);
    const lineLabels = lineMonths.map((d) => d.toLocaleString(locale, { month: 'short' }));

    const categories = await this.fetchCategoriesMap(userId, roomId);
    const transactions = await this.fetchExpenseTransactionsForOverview(now, userId, roomId);

    const byCategoryAndMonth = new Map<string, Map<number, number>>();
    for (const t of transactions) {
      const catId = t.category_id ?? '';
      const monthKey = t.date.getFullYear() * 12 + t.date.getMonth();
      if (!byCategoryAndMonth.has(catId)) {
        byCategoryAndMonth.set(catId, new Map());
      }
      const monthMap = byCategoryAndMonth.get(catId)!;
      monthMap.set(monthKey, (monthMap.get(monthKey) ?? 0) + parseFloat(t.amount));
    }

    const categoryIds = Array.from(byCategoryAndMonth.keys()).filter(Boolean);

    const pieLabels: string[] = [];
    const pieData: number[] = [];

    if (piePeriod === 'all') {
      const allTx = await this.fetchExpenseTransactionsAllTime(userId, roomId);
      const totals = new Map<string, number>();
      for (const t of allTx) {
        const catId = t.category_id ?? '';
        if (!catId) continue;
        totals.set(catId, (totals.get(catId) ?? 0) + parseFloat(t.amount));
      }
      const sorted = Array.from(totals.entries())
        .filter(([, sum]) => sum > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [catId, sum] of sorted) {
        const rounded = +sum.toFixed(2);
        if (rounded <= 0) continue;
        pieLabels.push(categories.get(catId) ?? catId);
        pieData.push(rounded);
      }
    } else {
      const pieMonthKeys = this.getPiePeriodMonthKeys(piePeriod, now);
      for (const catId of categoryIds) {
        const title = categories.get(catId) ?? catId;
        const monthMap = byCategoryAndMonth.get(catId)!;
        let sumForPie = 0;
        for (const [monthKey, v] of monthMap.entries()) {
          if (pieMonthKeys.has(monthKey)) sumForPie += v;
        }
        const rounded = +sumForPie.toFixed(2);
        if (rounded <= 0) continue;
        pieLabels.push(title);
        pieData.push(rounded);
      }
    }
    const pieColors = pieData.map((_, i) => this.palette[i % this.palette.length]);

    type CatSeries = { id: string; title: string; series: number[]; total: number };
    const barSeries: CatSeries[] = categoryIds.map((catId) => {
      const title = categories.get(catId) ?? catId;
      const monthMap = byCategoryAndMonth.get(catId)!;
      const series = barMonths.map((m) => {
        const key = m.getFullYear() * 12 + m.getMonth();
        return +(monthMap.get(key) ?? 0).toFixed(2);
      });
      const total = series.reduce((s, v) => s + v, 0);
      return { id: catId, title, series, total };
    });
    const sortedBar = barSeries.sort((a, b) => b.total - a.total);
    const topBar = typeof topK === 'number' && topK > 0 ? sortedBar.slice(0, topK) : sortedBar;
    const barDatasets = topBar.map((c, i) => ({
      label: c.title,
      data: c.series,
      backgroundColor: this.hexWithAlpha(this.palette[i % this.palette.length], 0.6),
    }));

    const lineData = lineMonths.map((m) => {
      const key = m.getFullYear() * 12 + m.getMonth();
      let monthSum = 0;
      for (const [, monthMap] of byCategoryAndMonth) {
        monthSum += monthMap.get(key) ?? 0;
      }
      return +monthSum.toFixed(2);
    });

    return {
      pie: {
        labels: pieLabels,
        datasets: [{ data: pieData, backgroundColor: pieColors }],
      },
      bar: {
        labels: barLabels,
        datasets: barDatasets,
      },
      line: {
        labels: lineLabels,
        datasets: [
          {
            label: 'Total Expenses',
            data: lineData,
            borderColor: '#4F46E5',
            tension: 0.35,
            fill: false,
          },
        ],
      },
      meta: { monthIndex: currentMonth, year, monthsBar, topK, piePeriod },
    };
  }

  private getPiePeriodMonthKeys(period: StatisticsPiePeriod, ref: Date): Set<number> {
    if (period === 'current_month') {
      return new Set([ref.getFullYear() * 12 + ref.getMonth()]);
    }
    const n = period === 'last_3' ? 3 : period === 'last_6' ? 6 : 12;
    const months = this.buildLastMonths(n, ref);
    return new Set(months.map((m) => m.getFullYear() * 12 + m.getMonth()));
  }

  private async fetchExpenseTransactionsAllTime(
    userId?: string,
    roomId?: string,
  ): Promise<TxRow[]> {
    if (roomId) {
      const { rows } = await this.pool.query(
        `SELECT category_id, date, amount::text AS amount FROM group_transactions
         WHERE room_id = $1 AND COALESCE(type::text, 'expense') = 'expense'`,
        [roomId],
      );
      return rows.map((r) => ({
        category_id: r.category_id,
        date: r.date instanceof Date ? r.date : new Date(r.date),
        amount: r.amount,
      }));
    }
    const sql = userId
      ? `SELECT category_id, date, amount FROM transactions WHERE type = 'expense' AND user_id = $1`
      : `SELECT category_id, date, amount FROM transactions WHERE type = 'expense'`;
    const params = userId ? [userId] : [];
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      category_id: r.category_id,
      date: r.date instanceof Date ? r.date : new Date(r.date),
      amount: r.amount,
    }));
  }

  private async fetchExpenseTransactions(
    year: number,
    lastMonthIndex: number,
    userId?: string,
    roomId?: string,
  ): Promise<TxRow[]> {
    const start = new Date(year, 0, 1);
    const end = new Date(year, lastMonthIndex + 1, 0);
    if (roomId) {
      const { rows } = await this.pool.query(
        `SELECT category_id, date, amount::text AS amount FROM group_transactions
         WHERE room_id = $1 AND date >= $2 AND date <= $3
           AND COALESCE(type::text, 'expense') = 'expense'`,
        [roomId, start, end],
      );
      return rows.map((r) => ({
        category_id: r.category_id,
        date: r.date instanceof Date ? r.date : new Date(r.date),
        amount: r.amount,
      }));
    }
    const sql = userId
      ? `SELECT category_id, date, amount FROM transactions
         WHERE type = 'expense' AND user_id = $1 AND date >= $2 AND date <= $3`
      : `SELECT category_id, date, amount FROM transactions
         WHERE type = 'expense' AND date >= $1 AND date <= $2`;
    const params = userId ? [userId, start, end] : [start, end];
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      category_id: r.category_id,
      date: r.date instanceof Date ? r.date : new Date(r.date),
      amount: r.amount,
    }));
  }

  private async fetchExpenseTransactionsForOverview(
    ref: Date,
    userId?: string,
    roomId?: string,
  ): Promise<TxRow[]> {
    const start = new Date(ref.getFullYear(), ref.getMonth() - 11, 1);
    const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
    if (roomId) {
      const { rows } = await this.pool.query(
        `SELECT category_id, date, amount::text AS amount FROM group_transactions
         WHERE room_id = $1 AND date >= $2 AND date <= $3
           AND COALESCE(type::text, 'expense') = 'expense'`,
        [roomId, start, end],
      );
      return rows.map((r) => ({
        category_id: r.category_id,
        date: r.date instanceof Date ? r.date : new Date(r.date),
        amount: r.amount,
      }));
    }
    const sql = userId
      ? `SELECT category_id, date, amount FROM transactions
         WHERE type = 'expense' AND user_id = $1 AND date >= $2 AND date <= $3`
      : `SELECT category_id, date, amount FROM transactions
         WHERE type = 'expense' AND date >= $1 AND date <= $2`;
    const params = userId ? [userId, start, end] : [start, end];
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      category_id: r.category_id,
      date: r.date instanceof Date ? r.date : new Date(r.date),
      amount: r.amount,
    }));
  }

  private async fetchCategoriesMap(userId?: string, roomId?: string): Promise<Map<string, string>> {
    let rows: { id: string; name: string }[];
    if (roomId) {
      const res = await this.pool.query(
        `SELECT id, name FROM categories
         WHERE group_room_id = $1 AND name = ANY($2::text[])`,
        [roomId, [...GROUP_ROOM_CATEGORY_NAMES]],
      );
      rows = res.rows;
    } else {
      const sql = userId
        ? 'SELECT id, name FROM categories WHERE user_id = $1 OR user_id IS NULL'
        : 'SELECT id, name FROM categories';
      const params = userId ? [userId] : [];
      const res = await this.pool.query(sql, params);
      rows = res.rows;
    }
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.id, r.name);
    }
    return map;
  }

  private groupExpensesByCategoryAndMonth(
    transactions: TxRow[],
    year: number,
    lastMonthIndex: number,
  ): Map<string, number[]> {
    const byCategory = new Map<string, number[]>();
    for (const t of transactions) {
      const catId = t.category_id ?? '';
      if (!byCategory.has(catId)) {
        byCategory.set(catId, new Array(lastMonthIndex + 1).fill(0));
      }
      const d = t.date instanceof Date ? t.date : new Date(t.date);
      if (d.getFullYear() !== year) continue;
      const m = d.getMonth();
      if (m <= lastMonthIndex) {
        const arr = byCategory.get(catId)!;
        arr[m] += parseFloat(t.amount);
      }
    }
    return byCategory;
  }

  private buildLastMonths(n: number, ref: Date): Date[] {
    const arr: Date[] = [];
    const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    for (let i = n - 1; i >= 0; i--) {
      arr.push(new Date(start.getFullYear(), start.getMonth() - i, 1));
    }
    return arr;
  }

  private hexWithAlpha(hex: string, alpha = 1): string {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

