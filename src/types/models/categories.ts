export interface CategoryItem {
  id: string;
  title: string;
  icon: string;
  color?: string;
  /** ISO date string; when the category was created. */
  createdAt?: string;
  /** ISO date string; updated when category is edited or a transaction is added to it. */
  updatedAt?: string;
  expenses: any[];
  revenues: any[];
  totalExpenses: number;
  totalRevenues: number;
}

export interface CreateCategoryItem {
  id?: string;
  name: string;
  icon?: string;
  color?: string;
  examples?: string[];
}

