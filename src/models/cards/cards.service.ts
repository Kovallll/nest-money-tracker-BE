import { Injectable } from '@nestjs/common';
import { TransactionsService } from '../transactions/transactions.service';

@Injectable()
export class CardsService {
  constructor(private readonly transactionsService: TransactionsService) {}

  getCards() {
    const transactions = this.transactionsService.getTransactions();

    return [
      {
        id: 0,
        cardName: 'Master Card',
        cardNumber: '**** **** **** 4328',
        cardBalance: 25.999,
        cardType: 'Credit Card',
        bankName: 'Bank of America',
        branchName: 'New York',
        transactions: [],
      },
      {
        id: 1,
        cardName: 'Master Card',
        cardNumber: '**** **** **** 4466',
        cardBalance: 65.123,
        cardType: 'Checking',
        bankName: 'Bank of America',
        branchName: 'New York',
        transactions: [],
      },
      {
        id: 2,
        cardName: 'Master Card',
        cardNumber: '**** **** **** 5555',
        cardBalance: 1.123,
        cardType: 'Savings',
        bankName: 'Bank of America',
        branchName: 'New York',
        transactions: [],
      },
      {
        id: 3,
        cardName: 'Master Card',
        cardNumber: '**** **** **** 5555',
        cardBalance: 1.123,
        cardType: 'Investment',
        bankName: 'Bank of America',
        branchName: 'New York',
        transactions: [],
      },
      {
        id: 4,
        cardName: 'Master Card',
        cardNumber: '**** **** **** 5555',
        cardBalance: 1.123,
        cardType: 'Credit Card',
        bankName: 'Bank of America',
        branchName: 'New York',
        transactions: [],
      },
      {
        id: 5,
        cardName: 'Master Card',
        cardNumber: '**** **** **** 5555',
        cardBalance: 1.123,
        cardType: 'Loan',
        bankName: 'Bank of America',
        branchName: 'New York',
        transactions: [],
      },
    ].map((card) => ({
      ...card,
      transactions: transactions.filter((t) => t.cardId === card.id),
    }));
  }
}
