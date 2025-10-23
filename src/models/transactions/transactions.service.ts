import { Tabs } from '@/enums';
import { Transaction } from '@/types';
import { Injectable } from '@nestjs/common';

@Injectable()
export class TransactionsService {
  getTransactions() {
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
    const statuses = ['Completed', 'Pending', 'Failed'];

    const transactions: Transaction[] = [];
    const startDate = new Date('2024-05-01');
    const endDate = new Date();

    let idCounter = 0;

    for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
      const numTransactions = Math.floor(Math.random() * 3) + 1;

      for (let i = 0; i < numTransactions; i++) {
        const isIncome = Math.random() < 0.3;
        const type = isIncome ? Tabs.Revenue : Tabs.Expenses;
        const category = isIncome
          ? categories.income[Math.floor(Math.random() * categories.income.length)]
          : categories.expense[Math.floor(Math.random() * categories.expense.length)];

        const amount = parseFloat((Math.random() * (isIncome ? 3000 : 200) + 5).toFixed(2));

        const title = isIncome
          ? incomeTitles[category][Math.floor(Math.random() * incomeTitles[category].length)]
          : expenseTitles[category][Math.floor(Math.random() * expenseTitles[category].length)];

        transactions.push({
          id: idCounter++,
          userId: Math.floor(Math.random() * 10) + 1,
          cardId: Math.floor(Math.random() * 5) + 1,
          title,
          category,
          amount,
          date: d.toISOString().split('T')[0],
          type,
          paymentMethod: paymentMethods[Math.floor(Math.random() * paymentMethods.length)],
          transactionType: transactionTypes[Math.floor(Math.random() * transactionTypes.length)],
          receipt: `receipt-${idCounter}.pdf`,
          status: statuses[Math.floor(Math.random() * statuses.length)],
        });
      }
    }

    return transactions;
  }
}
