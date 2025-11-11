export type Transaction = {
  id: number;
  userId: number;
  cardId: number;
  categoryId: number;
  title: string;
  category: string;
  amount: number;
  date: string;
  type: string;
  paymentMethod: string;
  transactionType: string;
  receipt: string;
  status: string;
};

export type TransactionCreate = Omit<Transaction, 'id' | 'userId' | 'cardId' | 'categoryId'>;
