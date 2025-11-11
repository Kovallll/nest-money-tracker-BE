export interface CategoryLineChartDto {
  categoryId: number;
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
  pie: ChartJsPie; // доли категорий за текущий месяц
  bar: ChartJsBar; // по категориям за последние N месяцев (топ-K)
  line: ChartJsLine; // суммарно по всем категориям за 12 мес.
  meta: {
    monthIndex: number; // 0..11 текущий месяц
    year: number;
    monthsBar: number;
    topK: number;
  };
}
