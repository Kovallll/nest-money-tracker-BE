export enum TransactionType {
  Revenues = 'revenue',
  Expenses = 'expense',
}

export enum Tabs {
  All = 'All',
  Expenses = TransactionType.Expenses,
  Revenues = TransactionType.Revenues,
}

