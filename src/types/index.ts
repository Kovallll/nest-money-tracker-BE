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
  targetBudget: number;
  goalBudget: number;
  startDate: string;
  endDate: string;
  title: string;
}

export interface SubscribeItem {
  id: string;
  amount: number;
  subscribeDate: string;
  subscribeName: string;
  lastCharge: string;
  type: string;
  description?: string;
}

