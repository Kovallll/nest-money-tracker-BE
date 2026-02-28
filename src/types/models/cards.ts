import { Transaction } from './transactions';

export interface BalanceCard {
  id: number;
  userId: string;
  cardName: string;
  cardNumber: string;
  cardType: string;
  bankName: string;
  /** Expiry in MM/YY format (e.g. "12/28"). Optional. */
  expiry?: string | null;
  cardBalance: number;
  /** Currency code (e.g. BYN, USD). Default BYN if missing. */
  currencyCode?: string;
  isActive: boolean;
  transactions: Transaction[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCard {
  userId: string;
  cardName: string;
  cardNumber: string;
  cardType: string;
  bankName: string;
  expiry?: string | null;
  cardBalance?: number;
  currencyCode?: string;
}
