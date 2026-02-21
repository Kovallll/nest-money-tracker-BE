import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { CategoryLineChartDto, ExpensesOverviewDto } from '@/types';

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
  }): Promise<CategoryLineChartDto[]> {
    const year = params?.year ?? new Date().getFullYear();
    const locale = params?.locale ?? 'en';
    const limitToCurrent = params?.monthsLimitToCurrent ?? true;
    const top = params?.top;
    const userId = params?.userId;

    const now = new Date();
    const lastMonthIndex = limitToCurrent && year === now.getFullYear() ? now.getMonth() : 11;

    const labels = Array.from({ length: lastMonthIndex + 1 }, (_, m) =>
      new Date(year, m, 1).toLocaleString(locale, { month: 'short' }),
    );

    const transactions = await this.fetchExpenseTransactions(year, lastMonthIndex, userId);
    const categories = await this.fetchCategoriesMap();

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
  }): Promise<ExpensesOverviewDto> {
    const monthsBar = params?.monthsBar ?? 6;
    const topK = params?.topK ?? 5;
    const locale = params?.locale ?? 'en';
    const userId = params?.userId;

    const now = new Date();
    const year = now.getFullYear();
    const currentMonth = now.getMonth();

    const barMonths = this.buildLastMonths(monthsBar, now);
    const barLabels = barMonths.map((d) => d.toLocaleString(locale, { month: 'short' }));

    const lineMonths = this.buildLastMonths(12, now);
    const lineLabels = lineMonths.map((d) => d.toLocaleString(locale, { month: 'short' }));

    const categories = await this.fetchCategoriesMap();
    const transactions = await this.fetchExpenseTransactionsForOverview(now, userId);

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

    const pieLabels: string[] = [];
    const pieData: number[] = [];
    const currentMonthKey = year * 12 + currentMonth;
    const categoryIds = Array.from(byCategoryAndMonth.keys()).filter(Boolean);
    for (const catId of categoryIds) {
      const title = categories.get(catId) ?? catId;
      const monthMap = byCategoryAndMonth.get(catId)!;
      const sum = monthMap.get(currentMonthKey) ?? 0;
      pieLabels.push(title);
      pieData.push(+sum.toFixed(2));
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
    const topBar = barSeries.sort((a, b) => b.total - a.total).slice(0, topK);
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
      meta: { monthIndex: currentMonth, year, monthsBar, topK },
    };
  }

  private async fetchExpenseTransactions(
    year: number,
    lastMonthIndex: number,
    userId?: string,
  ): Promise<TxRow[]> {
    const start = new Date(year, 0, 1);
    const end = new Date(year, lastMonthIndex + 1, 0);
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

  private async fetchExpenseTransactionsForOverview(ref: Date, userId?: string): Promise<TxRow[]> {
    const start = new Date(ref.getFullYear(), ref.getMonth() - 11, 1);
    const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
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

  private async fetchCategoriesMap(): Promise<Map<string, string>> {
    const { rows } = await this.pool.query('SELECT id, name FROM categories');
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

