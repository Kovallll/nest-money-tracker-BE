export interface CategoryItem {
  id: string;
  title: string;
  icon: string;
  color?: string;
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

