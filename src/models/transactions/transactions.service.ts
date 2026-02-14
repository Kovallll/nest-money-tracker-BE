import { Tabs } from '@/enums';
import { Transaction, TransactionCreate } from '@/types';
import { Injectable } from '@nestjs/common';

@Injectable()
export class TransactionsService {
  private transactions: Transaction[] = [];

  constructor() {
    this.seedTransactions(); // Генерируем данные один раз при запуске
  }

  private seedTransactions() {
    const expenseTitles: Record<string, string[]> = {
      Food: ['Grocery Store', 'Restaurant Dinner', 'Coffee Shop', 'Fast Food Order'],
      Transport: ['Bus Ticket', 'Taxi Ride', 'Gas Station', 'Train Ticket'],
      Entertainment: ['Movie Ticket', 'Concert', 'Online Game', 'Streaming Service'],
      Shopping: ['Clothes Store', 'Electronics Shop', 'Home Supplies', 'Bookstore'],
      Health: ['Pharmacy Purchase', 'Doctor Visit', 'Gym Membership', 'Dental Service'],
      Education: ['Course Payment', 'Books Purchase', 'Online Lesson', 'Exam Fee'],
      Other: ['Gift Purchase', 'Charity Donation', 'Miscellaneous Expense'],
    };

    const incomeTitles: Record<string, string[]> = {
      Salary: ['Monthly Salary', 'Paycheck'],
      Bonus: ['Performance Bonus', 'Holiday Bonus', 'Annual Bonus'],
      Freelance: ['Freelance Project Payment', 'Client Transfer'],
      Investments: ['Stock Dividend', 'Crypto Profit', 'Bank Interest'],
    };

    const categories = {
      expense: Object.keys(expenseTitles),
      income: Object.keys(incomeTitles),
    };

    const paymentMethods = ['Card', 'Cash', 'Bank Transfer', 'Crypto'];
    const transactionTypes = ['Purchase', 'Refund', 'Transfer', 'Deposit'];
    const statuses = ['completed', 'pending', 'cancelled'];

    const startDate = new Date('2024-05-01');
    const endDate = new Date();
    let idCounter = 0;

    for (let i = 0; i < 500; i++) {
      const isIncome = Math.random() < 0.3;
      const type = isIncome ? Tabs.Revenues : Tabs.Expenses;
      const category = isIncome
        ? categories.income[Math.floor(Math.random() * categories.income.length)]
        : categories.expense[Math.floor(Math.random() * categories.expense.length)];

      const amount = parseFloat((Math.random() * (isIncome ? 3000 : 200) + 5).toFixed(2));
      const title = isIncome
        ? incomeTitles[category][Math.floor(Math.random() * incomeTitles[category].length)]
        : expenseTitles[category][Math.floor(Math.random() * expenseTitles[category].length)];

      const randomDate = new Date(
        startDate.getTime() + Math.random() * (endDate.getTime() - startDate.getTime()),
      );

      this.transactions.push({
        id: idCounter++,
        userId: Math.floor(Math.random() * 10) + 1,
        cardId: Math.floor(Math.random() * 5) + 1,
        categoryId: Math.floor(Math.random() * 7),
        title,
        amount,
        date: randomDate.toISOString().split('T')[0],
        type,
        paymentMethod: paymentMethods[Math.floor(Math.random() * paymentMethods.length)],
        transactionType: transactionTypes[Math.floor(Math.random() * transactionTypes.length)],
        receipt: `receipt-${idCounter}.pdf`,
        status: statuses[Math.floor(Math.random() * statuses.length)] as
          | 'cancelled'
          | 'pending'
          | 'completed',
      });
    }
  }

  getTransactions() {
    return this.transactions;
  }

  createTransaction(transaction: TransactionCreate) {
    const newTransaction = {
      ...transaction,
      id: this.transactions.length + 1,
      date: new Date().toISOString().split('T')[0],
      userId: Math.floor(Math.random() * 10) + 1,
      cardId: Math.floor(Math.random() * 5) + 1,
      categoryId: Math.floor(Math.random() * 7),
    };
    this.transactions.unshift(newTransaction);
    return newTransaction;
  }

  deleteTransaction(id: number) {
    this.transactions = this.transactions.filter((t) => t.id !== id);
    return { success: true };
  }

  updateTransaction(id: number, updateTransaction: TransactionCreate) {
    const index = this.transactions.findIndex((t) => t.id === id);
    if (index === -1) return null;
    this.transactions[index] = { ...this.transactions[index], ...updateTransaction };
    return this.transactions[index];
  }
}

