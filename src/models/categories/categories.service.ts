import { Injectable } from '@nestjs/common';
import { TransactionsService } from '../transactions/transactions.service';
import { Tabs } from '@/enums';
import { CategoryItem, CreateCategoryItem } from '@/types';

@Injectable()
export class CategoriesService {
  private categories: CategoryItem[] = [];

  constructor(private readonly transactionsService: TransactionsService) {
    this.categories = this.initCategories();
  }

  private seed: CategoryItem[] = [
    {
      id: 1,
      title: 'Auto',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 2,
      title: 'Transport',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 3,
      title: 'Food',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 4,
      title: 'Shopping',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 5,
      title: 'Entertainments',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 6,
      title: 'Other',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 7,
      title: 'Courses',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
    {
      id: 8,
      title: 'Medicine',
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
      icon: 'pi pi-table',
    },
  ];

  private initCategories(): CategoryItem[] {
    const byId: Record<number, CategoryItem> = Object.fromEntries(
      this.seed.map((c) => [
        c.id,
        { ...c, revenues: [], expenses: [], totalExpenses: 0, totalRevenues: 0 },
      ]),
    );

    const transactions = this.transactionsService.getTransactions();

    for (const t of transactions) {
      const cat = byId[t.categoryId];
      if (!cat) continue;

      if (t.type === Tabs.Expenses) {
        cat.expenses.push(t);
        cat.totalExpenses += t.amount;
      } else {
        cat.revenues.push(t);
        cat.totalRevenues += t.amount;
      }
    }

    return Object.values(byId);
  }

  getCategories(): CategoryItem[] {
    return this.categories;
  }

  createCategory(category: CreateCategoryItem) {
    const newCategory: CategoryItem = {
      id: this.seed.length + 1,
      ...category,
      revenues: [],
      expenses: [],
      totalExpenses: 0,
      totalRevenues: 0,
    };
    this.seed.push(newCategory);
    this.categories = this.initCategories();
  }

  deleteCategory(id: number) {
    this.seed = this.seed.filter((c) => c.id !== id);
    this.categories = this.initCategories();
  }

  updateCategory(id: number, category: CreateCategoryItem) {
    this.seed = this.seed.map((c) => (c.id === id ? { ...c, ...category } : c));
    this.categories = this.initCategories();
  }
}
