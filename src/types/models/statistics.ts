export interface CategoryLineChartDto {
  categoryId: string;
  title: string;
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    borderColor: string;
    backgroundColor?: string;
    tension?: number;
    pointRadius?: number;
    fill?: boolean;
  }>;
}

/** Период агрегации для круговой диаграммы «Categories share» (query `piePeriod`). */
export type StatisticsPiePeriod =
  | 'current_month'
  | 'last_3'
  | 'last_6'
  | 'last_12'
  | 'all';

export interface ChartJsPie {
  labels: string[];
  datasets: Array<{ data: number[]; backgroundColor: string[] }>;
}

export interface ChartJsBar {
  labels: string[]; // месяцы
  datasets: Array<{ label: string; data: number[]; backgroundColor?: string }>;
}

export interface ChartJsLine {
  labels: string[]; // месяцы
  datasets: Array<{
    label: string;
    data: number[];
    borderColor?: string;
    tension?: number;
    fill?: boolean;
  }>;
}

export interface ExpensesOverviewDto {
  pie: ChartJsPie; // доли категорий за период meta.piePeriod
  bar: ChartJsBar; // по категориям за последние N месяцев (топ-K)
  line: ChartJsLine; // суммарно по всем категориям за 12 мес.
  meta: {
    monthIndex: number; // 0..11 текущий месяц
    year: number;
    monthsBar: number;
    topK?: number; // при отсутствии показываются все категории
    piePeriod: StatisticsPiePeriod;
  };
}

