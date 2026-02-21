import { CategoryItem } from './models';

export * from './models';

export type User = {
  name: string;
  lastname: string;
  phone: string;
  email: string;
  password: string;
  avatar?: string;
};

export interface ExpenseItem {
  id: string;
  category: Pick<CategoryItem, 'id' | 'title'>;
  amount: number;
  date: string;
  title: string;
}

export interface GoalItem {
  id: string;
  userId?: string;
  categoryId?: string | null;
  title: string;
  targetBudget: number;
  goalBudget: number;
  startDate: string;
  endDate: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SubscribeItem {
  id: string;
  userId?: string;
  categoryId?: string | null;
  subscribeName: string;
  subscribeDate: string;
  amount: number;
  lastCharge: string | null;
  type: string;
  description?: string | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

