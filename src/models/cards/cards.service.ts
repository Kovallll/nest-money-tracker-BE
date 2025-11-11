import { Injectable, Logger } from '@nestjs/common';
import { TransactionsService } from '../transactions/transactions.service';
import { BalanceCard, CreateCard } from '@/types/models/cards';
@Injectable()
export class CardsService {
  constructor(private readonly transactionsService: TransactionsService) {}
  private _id = 6;

  private cards: BalanceCard[] = [
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
  ];

  getCards() {
    const transactions = this.transactionsService.getTransactions();

    return this.cards.map((card) => ({
      ...card,
      transactions: transactions.filter((t) => t.cardId === card.id),
    }));
  }

  getCard(id: number) {
    return this.getCards().find((card) => card.id === id);
  }

  addCard(card: CreateCard) {
    this.cards.push({ id: this._id, ...card, transactions: [] });
    this._id++;
  }

  deleteCard(id: number) {
    this.cards = this.cards.filter((card) => card.id !== id);
  }

  updateCard(id: number, card: CreateCard) {
    this.cards = this.cards.map((c) => (c.id === id ? { ...c, ...card } : c));
  }
}
