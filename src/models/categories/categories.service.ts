import { CategoryItem } from '@/types';
import { Injectable } from '@nestjs/common';
import { ExpensesService } from '../expenses/expenses.service';

@Injectable()
export class CategoriesService {
  constructor(private readonly expensesService: ExpensesService) {}

  getCategories() {
    const categoryTitles = [
      'Auto',
      'Transport',
      'Food',
      'Shopping',
      'Entertainments',
      'Other',
      'Courses',
    ];

    const expenses = this.expensesService.getExpenses();

    const categories: CategoryItem[] = Object.values(
      expenses.reduce<Record<number, CategoryItem>>((acc, expense) => {
        const catId = expense.category.id;

        if (!acc[catId]) {
          acc[catId] = {
            id: catId,
            title: expense.category.title,
            expensesAmount: 0,
            expenses: [],
          };
        }

        acc[catId].expenses.push(expense);
        acc[catId].expensesAmount += expense.amount;

        return acc;
      }, {}),
    );

    categoryTitles.forEach((title, id) => {
      if (!categories.find((c) => c.id === id)) {
        categories.push({
          id,
          title,
          expensesAmount: 0,
          expenses: [],
        });
      }
    });

    return categories;
  }
}
