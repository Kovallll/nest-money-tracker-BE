export interface SeedCard {
  cardName: string;
  cardNumber: string;
  cardType: string;
  bankName: string;
  branchName: string;
  cardBalance: number;
}

export const seedCards: SeedCard[] = [
  {
    cardName: 'Tinkoff Black',
    cardNumber: '**** **** **** 7721',
    cardType: 'Debit',
    bankName: 'Тинькофф',
    branchName: 'Москва',
    cardBalance: 84350.5,
  },
  {
    cardName: 'Sber Visa Gold',
    cardNumber: '**** **** **** 3390',
    cardType: 'Debit',
    bankName: 'Сбербанк',
    branchName: 'Санкт-Петербург',
    cardBalance: 215000.0,
  },
  {
    cardName: 'Alfa Cash Back',
    cardNumber: '**** **** **** 5012',
    cardType: 'Credit',
    bankName: 'Альфа-Банк',
    branchName: 'Москва',
    cardBalance: 42780.25,
  },
  {
    cardName: 'VTB Мультикарта',
    cardNumber: '**** **** **** 6648',
    cardType: 'Debit',
    bankName: 'ВТБ',
    branchName: 'Казань',
    cardBalance: 9120.0,
  },
  {
    cardName: 'Raiffeisen Premium',
    cardNumber: '**** **** **** 1185',
    cardType: 'Savings',
    bankName: 'Райффайзен',
    branchName: 'Москва',
    cardBalance: 530000.0,
  },
];
