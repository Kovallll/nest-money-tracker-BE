export type Transaction = {
  id: number;
  userId: string;
  cardId: string;
  categoryId: string;
  type: 'expense' | 'revenue';
  amount: number;
  title?: string | null;
  description?: string | null;
  date: string;
  createdAt?: string;
  updatedAt?: string;
};

export type TransactionCreate = Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>;

