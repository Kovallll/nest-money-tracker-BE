export type Transaction = {
  id: number;
  userId: number;
  cardId?: number | null;
  categoryId?: number | null;
  title: string;
  amount: number;
  date: string;
  type: 'expense' | 'revenue';
  paymentMethod?: string;
  transactionType?: string;
  receipt?: string;
  status: 'pending' | 'completed' | 'cancelled';
  createdAt?: string;
  updatedAt?: string;
};

export type TransactionCreate = Omit<Transaction, 'id' | 'userId' | 'cardId' | 'categoryId'>;

