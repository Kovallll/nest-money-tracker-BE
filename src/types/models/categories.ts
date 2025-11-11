import { Transaction } from './transactions';

export interface CategoryItem {
  id: number;
  title: string;
  expenses: Transaction[];
  revenues: Transaction[];
  totalExpenses: number;
  totalRevenues: number;
  icon: string;
}

export interface CreateCategoryItem {
  title: string;
  icon: string;
}
