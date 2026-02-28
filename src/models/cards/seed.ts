export interface SeedCard {
  cardName: string;
  cardNumber: string;
  cardType: string;
  bankName: string;
  expiry?: string;
  cardBalance: number;
}

export const seedCards: SeedCard[] = [
  {
    cardName: 'Tinkoff Black',
    cardNumber: '**** **** **** 7721',
    cardType: 'Debit',
    bankName: 'Тинькофф',
    expiry: '12/28',
    cardBalance: 84350.5,
  },
  {
    cardName: 'Sber Visa Gold',
    cardNumber: '**** **** **** 3390',
    cardType: 'Debit',
    bankName: 'Сбербанк',
    expiry: '06/29',
    cardBalance: 215000.0,
  },
  {
    cardName: 'Alfa Cash Back',
    cardNumber: '**** **** **** 5012',
    cardType: 'Credit',
    bankName: 'Альфа-Банк',
    expiry: '03/27',
    cardBalance: 42780.25,
  },
  {
    cardName: 'VTB Мультикарта',
    cardNumber: '**** **** **** 6648',
    cardType: 'Debit',
    bankName: 'ВТБ',
    expiry: '09/30',
    cardBalance: 9120.0,
  },
  {
    cardName: 'Raiffeisen Premium',
    cardNumber: '**** **** **** 1185',
    cardType: 'Savings',
    bankName: 'Райффайзен',
    expiry: '01/29',
    cardBalance: 530000.0,
  },
];
