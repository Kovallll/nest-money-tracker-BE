import { Transaction } from './transactions';

export interface BalanceCard {
  id: number;
  cardName: string;
  cardNumber: string;
  cardBalance: number;
  cardType: string;
  bankName: string;
  branchName: string;
  transactions: Transaction[];
}

export interface CreateCard {
  cardName: string;
  cardNumber: string;
  cardBalance: number;
  cardType: string;
  bankName: string;
  branchName: string;
}
