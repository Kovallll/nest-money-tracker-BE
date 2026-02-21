export interface SeedSubscription {
  subscribeName: string;
  subscribeDate: string;
  amount: number;
  lastCharge?: string;
  type: string;
  description?: string;
}

export const seedSubscriptions: SeedSubscription[] = [
  {
    subscribeName: 'Netflix',
    subscribeDate: '2024-06-01',
    amount: 799,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: 'Premium',
  },
  {
    subscribeName: 'Spotify',
    subscribeDate: '2024-01-15',
    amount: 169,
    lastCharge: '2025-02-15',
    type: 'monthly',
    description: 'Family',
  },
  {
    subscribeName: 'YouTube Premium',
    subscribeDate: '2024-03-01',
    amount: 299,
    lastCharge: '2025-02-01',
    type: 'monthly',
  },
  {
    subscribeName: 'Яндекс Плюс',
    subscribeDate: '2024-09-01',
    amount: 299,
    lastCharge: '2025-02-01',
    type: 'monthly',
  },
  {
    subscribeName: 'ChatGPT Plus',
    subscribeDate: '2024-11-01',
    amount: 1990,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: 'Pro',
  },
  {
    subscribeName: 'Adobe CC',
    subscribeDate: '2024-01-01',
    amount: 5490,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: 'Full Suite',
  },
  {
    subscribeName: 'Figma',
    subscribeDate: '2024-05-01',
    amount: 1290,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: 'Pro',
  },
  {
    subscribeName: 'Google One',
    subscribeDate: '2024-02-01',
    amount: 199,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: '100 GB',
  },
  {
    subscribeName: 'iCloud',
    subscribeDate: '2024-04-01',
    amount: 149,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: '50 GB',
  },
  {
    subscribeName: 'Notion',
    subscribeDate: '2024-07-01',
    amount: 450,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: 'Plus',
  },
  {
    subscribeName: 'Coursera',
    subscribeDate: '2025-01-01',
    amount: 5990,
    lastCharge: '2025-01-01',
    type: 'yearly',
    description: 'Annual',
  },
  {
    subscribeName: 'Дзен',
    subscribeDate: '2024-08-01',
    amount: 199,
    lastCharge: '2025-02-01',
    type: 'monthly',
    description: 'Подписка',
  },
];

