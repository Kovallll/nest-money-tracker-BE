import { Injectable } from '@nestjs/common';
import { CategoriesService } from '../categories/categories.service';
import { CategoryLineChartDto, ExpensesOverviewDto } from '@/types';

@Injectable()
export class StatisticsService {
  constructor(private readonly categoriesService: CategoriesService) {}

  /**
   * Массив графиков: по одной линии "Expenses" для каждой категории за указанный год.
   * monthsLimit=true — включаем месяцы с Jan..текущий (без будущих).
   * top — можно ограничить топ-N категорий по сумме расходов (опционально).
   */
  async getCategoryExpenseLineChartsByYear(params?: {
    year?: number;
    monthsLimitToCurrent?: boolean;
    top?: number;
    locale?: string;
  }) {
    const year = 2025;
    const locale = params?.locale ?? 'en';
    const limitToCurrent = params?.monthsLimitToCurrent ?? true;
    const top = params?.top;

    const categories = await this.categoriesService.getCategories();
    const now = new Date();
    const lastMonthIndex = limitToCurrent && year === now.getFullYear() ? now.getMonth() : 11;

    const labels = Array.from({ length: lastMonthIndex + 1 }, (_, m) =>
      new Date(year, m, 1).toLocaleString(locale, { month: 'short' }),
    );

    // Готовим палитру
    const palette = [
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

    const charts = categories.map((cat, idx) => {
      const monthly = new Array(lastMonthIndex + 1).fill(0);

      for (const t of cat.expenses ?? []) {
        // ожидается, что t.date — строка/Date
        const d = new Date(t.date as any);
        if (d.getFullYear() !== year) continue;
        const m = d.getMonth();
        if (m <= lastMonthIndex) monthly[m] += t.amount;
      }

      return {
        categoryId: cat.id,
        title: cat.title,
        labels,
        datasets: [
          {
            label: 'Expenses',
            data: monthly.map((v) => +v.toFixed(2)),
            borderColor: palette[idx % palette.length],
            backgroundColor: 'transparent',
            tension: 0.3,
            pointRadius: 2,
            fill: false,
          },
        ],
      } as CategoryLineChartDto;
    });

    const sorted = charts.sort((a, b) => sum(b.datasets[0].data) - sum(a.datasets[0].data));

    return typeof top === 'number' ? sorted.slice(0, top) : sorted;
  }

  async getExpensesOverview(params?: { monthsBar?: number; topK?: number; locale?: string }) {
    const monthsBar = params?.monthsBar ?? 6;
    const topK = params?.topK ?? 5;
    const locale = params?.locale ?? 'en';

    const now = new Date();
    const year = now.getFullYear();
    const currentMonth = now.getMonth();

    const barMonths = buildLastMonths(monthsBar, now);
    const barLabels = barMonths.map((d) => d.toLocaleString(locale, { month: 'short' }));

    const lineMonths = buildLastMonths(12, now);
    const lineLabels = lineMonths.map((d) => d.toLocaleString(locale, { month: 'short' }));

    const categories = await this.categoriesService.getCategories();

    const pieLabels: string[] = [];
    const pieData: number[] = [];

    for (const cat of categories) {
      const sum = (cat.expenses ?? [])
        .filter((t) => {
          const d = new Date(t.date as any);
          return d.getFullYear() === year && d.getMonth() === currentMonth;
        })
        .reduce((s, t) => s + t.amount, 0);

      pieLabels.push(cat.title);
      pieData.push(+sum.toFixed(2));
    }

    const palette = [
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
    const pieColors = pieData.map((_, i) => palette[i % palette.length]);

    // ---- Bar: по категориям за последние N месяцев (топ-K по сумме)
    // Посчитаем суммы по каждой категории по месяцам
    type CatSeries = { id: string; title: string; series: number[]; total: number };
    const barSeries: CatSeries[] = categories.map((cat) => {
      const series = barMonths.map((m) => {
        const sum = (cat.expenses ?? [])
          .filter((t) => isSameMonth(new Date(t.date as any), m))
          .reduce((s, t) => s + t.amount, 0);
        return +sum.toFixed(2);
      });
      return { id: cat.id, title: cat.title, series, total: series.reduce((s, v) => s + v, 0) };
    });

    // Оставим только топ-K категорий по суммарным расходам за период
    const topBar = barSeries.sort((a, b) => b.total - a.total).slice(0, topK);

    const barDatasets = topBar.map((c, i) => ({
      label: c.title,
      data: c.series,
      backgroundColor: hexWithAlpha(palette[i % palette.length], 0.6),
    }));

    // ---- Line: сумма по всем категориям за 12 месяцев
    const lineData = lineMonths.map((m) => {
      const monthSum = categories.reduce((acc, cat) => {
        const s = (cat.expenses ?? [])
          .filter((t) => isSameMonth(new Date(t.date as any), m))
          .reduce((s, t) => s + t.amount, 0);
        return acc + s;
      }, 0);
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
}

function buildLastMonths(n: number, ref: Date): Date[] {
  const arr: Date[] = [];
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  for (let i = n - 1; i >= 0; i--) {
    arr.push(new Date(start.getFullYear(), start.getMonth() - i, 1));
  }
  return arr;
}
function isSameMonth(d: Date, m: Date) {
  return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth();
}
function hexWithAlpha(hex: string, alpha = 1) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)!;
  const r = parseInt(m[1], 16),
    g = parseInt(m[2], 16),
    b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sum(arr: number[]) {
  return arr.reduce((s, v) => s + v, 0);
}

