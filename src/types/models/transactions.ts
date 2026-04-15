export type Transaction = {
  id: number;
  userId: string;
  cardId: string;
  /** Карта зачисления при type = transfer. */
  transferToCardId?: string | null;
  /** Для перевода между картами может быть пустым. */
  categoryId?: string | null;
  /** Category name (from JOIN when listing by user). */
  category?: string | null;
  type: 'expense' | 'revenue' | 'transfer';
  amount: number;
  /** Currency code (e.g. BYN, USD). Default BYN if missing. */
  currencyCode?: string;
  title?: string | null;
  description?: string | null;
  date: string;
  /** Payment method: cash or card. Optional. */
  paymentMethod?: 'cash' | 'card' | null;
  /** When false, transaction is linked to the card but balance is not changed. Default true. */
  affectsCardBalance?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type TransactionCreate = Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'> & {
  predictionKey?: string;
  predictedCategoryId?: string | null;
};

