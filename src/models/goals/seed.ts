export interface SeedGoal {
  title: string;
  targetBudget: number;
  goalBudget: number;
  startDate: string;
  endDate: string;
}

export const seedGoals: SeedGoal[] = [
  {
    title: 'Резервный фонд',
    targetBudget: 50000,
    goalBudget: 300000,
    startDate: '2025-01-01',
    endDate: '2025-12-31',
  },
  {
    title: 'Отпуск летом',
    targetBudget: 20000,
    goalBudget: 150000,
    startDate: '2025-02-01',
    endDate: '2025-07-01',
  },
  {
    title: 'Новый ноутбук',
    targetBudget: 30000,
    goalBudget: 120000,
    startDate: '2025-01-15',
    endDate: '2025-09-01',
  },
  {
    title: 'Курсы английского',
    targetBudget: 5000,
    goalBudget: 45000,
    startDate: '2025-03-01',
    endDate: '2025-12-01',
  },
  {
    title: 'Ремонт в квартире',
    targetBudget: 100000,
    goalBudget: 500000,
    startDate: '2025-01-01',
    endDate: '2026-06-30',
  },
  {
    title: 'Автомобиль',
    targetBudget: 200000,
    goalBudget: 1500000,
    startDate: '2025-01-01',
    endDate: '2027-12-31',
  },
  {
    title: 'Подушка безопасности',
    targetBudget: 30000,
    goalBudget: 200000,
    startDate: '2025-02-01',
    endDate: '2025-12-31',
  },
  {
    title: 'Свадьба',
    targetBudget: 100000,
    goalBudget: 800000,
    startDate: '2025-01-01',
    endDate: '2026-05-01',
  },
];
