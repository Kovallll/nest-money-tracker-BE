export interface SeedTransaction {
  type: 'expense' | 'revenue';
  amount: number;
  title: string;
  description?: string;
  date: string;
  categoryName?: string;
}

export const seedTransactions: SeedTransaction[] = [
  // --- Расходы ---
  {
    type: 'expense',
    amount: 4500.0,
    title: 'Продукты в Пятёрочке',
    description: 'Еженедельная закупка продуктов',
    date: '2025-02-01',
    categoryName: 'Food',
  },
  {
    type: 'expense',
    amount: 1200.0,
    title: 'Такси Яндекс',
    description: 'Поездка на работу',
    date: '2025-02-02',
    categoryName: 'Transport',
  },
  {
    type: 'expense',
    amount: 350.0,
    title: 'Кофе и круассан',
    description: 'Завтрак в кофейне',
    date: '2025-02-03',
    categoryName: 'Food',
  },
  {
    type: 'expense',
    amount: 8990.0,
    title: 'Курс по TypeScript',
    description: 'Онлайн-курс на Udemy',
    date: '2025-02-04',
    categoryName: 'Courses',
  },
  {
    type: 'expense',
    amount: 2500.0,
    title: 'Аптека',
    description: 'Витамины и парацетамол',
    date: '2025-02-05',
    categoryName: 'Medicine',
  },
  {
    type: 'expense',
    amount: 15000.0,
    title: 'Кроссовки Nike',
    description: 'Новые кроссовки для бега',
    date: '2025-02-06',
    categoryName: 'Shopping',
  },
  {
    type: 'expense',
    amount: 750.0,
    title: 'Кино',
    description: 'Два билета на премьеру',
    date: '2025-02-07',
    categoryName: 'Entertainments',
  },
  {
    type: 'expense',
    amount: 3200.0,
    title: 'Бензин АИ-95',
    description: 'Заправка на Лукойл',
    date: '2025-02-08',
    categoryName: 'Auto',
  },
  {
    type: 'expense',
    amount: 1800.0,
    title: 'Ужин в ресторане',
    description: 'Пицца и паста на двоих',
    date: '2025-02-09',
    categoryName: 'Food',
  },
  {
    type: 'expense',
    amount: 500.0,
    title: 'Подписка Spotify',
    description: 'Ежемесячная подписка на музыку',
    date: '2025-02-10',
    categoryName: 'Entertainments',
  },
  {
    type: 'expense',
    amount: 6700.0,
    title: 'Стоматолог',
    description: 'Чистка зубов',
    date: '2025-02-11',
    categoryName: 'Medicine',
  },
  {
    type: 'expense',
    amount: 2300.0,
    title: 'Метро проездной',
    description: 'Пополнение карты Тройка',
    date: '2025-02-12',
    categoryName: 'Transport',
  },
  {
    type: 'expense',
    amount: 4200.0,
    title: 'Книги',
    description: 'Учебник по алгоритмам и роман',
    date: '2025-02-13',
    categoryName: 'Courses',
  },
  {
    type: 'expense',
    amount: 950.0,
    title: 'Подарок другу',
    description: 'День рождения',
    date: '2025-02-14',
    categoryName: 'Other',
  },
  {
    type: 'expense',
    amount: 3500.0,
    title: 'Продукты на неделю',
    description: 'Мясо, овощи, молочка',
    date: '2025-02-15',
    categoryName: 'Food',
  },

  // --- Доходы ---
  {
    type: 'revenue',
    amount: 120000.0,
    title: 'Зарплата',
    description: 'Основная зарплата за февраль',
    date: '2025-02-01',
  },
  {
    type: 'revenue',
    amount: 25000.0,
    title: 'Фриланс проект',
    description: 'Верстка лендинга для клиента',
    date: '2025-02-05',
  },
  {
    type: 'revenue',
    amount: 8500.0,
    title: 'Кэшбек',
    description: 'Кэшбек за январь по карте',
    date: '2025-02-10',
  },
  {
    type: 'revenue',
    amount: 15000.0,
    title: 'Возврат долга',
    description: 'Друг вернул долг',
    date: '2025-02-12',
  },
  {
    type: 'revenue',
    amount: 3200.0,
    title: 'Проценты по вкладу',
    description: 'Ежемесячные проценты',
    date: '2025-02-15',
  },
];
