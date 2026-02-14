import { ExpenseItem } from '@/types';
import { Injectable } from '@nestjs/common';

@Injectable()
export class ExpensesService {
  getExpenses() {
    const categoryTitles = [
      'Auto',
      'Transport',
      'Food',
      'Shopping',
      'Entertainments',
      'Other',
      'Courses',
    ];

    // Генерация случайного числа в диапазоне
    const randomAmount = (min: number, max: number) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    // Генерация случайной даты в 2024 году
    const randomDate = () => {
      const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
      const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      return `2024-${month}-${day}`;
    };

    // Генерация случайного названия расхода
    const randomTitle = (category: string) => {
      const items: Record<string, string[]> = {
        Auto: ['Car repair', 'Fuel', 'Parking'],
        Transport: ['Bus ticket', 'Metro ticket', 'Taxi'],
        Food: ['Groceries', 'Restaurant', 'Coffee'],
        Shopping: ['Clothes', 'Shoes', 'Accessories'],
        Entertainments: ['Cinema tickets', 'Concert', 'Games'],
        Other: ['Miscellaneous', 'Office supplies', 'Subscriptions'],
        Courses: ['Online course', 'Books', 'Workshop'],
      };
      const arr = items[category] || ['Expense'];
      return arr[Math.floor(Math.random() * arr.length)];
    };

    // Количество расходов для генерации
    const NUM_EXPENSES = 500;

    const expenses: ExpenseItem[] = Array.from({ length: NUM_EXPENSES }, (_, i) => {
      const categoryId = Math.floor(Math.random() * categoryTitles.length);
      const categoryTitle = categoryTitles[categoryId];

      return {
        id: String(i),
        amount: randomAmount(10, 1000),
        date: randomDate(),
        title: randomTitle(categoryTitle),
        category: { id: String(categoryId), title: categoryTitle },
      };
    });

    return expenses;
  }
}

