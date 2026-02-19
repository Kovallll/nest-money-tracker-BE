import { Transaction } from './transactions';

export interface BalanceCard {
  id: number;
  userId: string;
  cardName: string;
  cardNumber: string;
  cardType: string;
  bankName: string;
  branchName: string;
  cardBalance: number;
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
  branchName: string;
  cardBalance?: number;
}
