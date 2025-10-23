import { SubscribeItem } from '@/types';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SubscribtionsService {
  getSubscribes() {
    const services = [
      { name: 'Figma', desc: 'Pro' },
      { name: 'GitHub', desc: 'Team' },
      { name: 'Netflix', desc: 'Premium' },
      { name: 'Spotify', desc: 'Family' },
      { name: 'Notion', desc: 'Plus' },
      { name: 'Adobe CC', desc: 'Full Suite' },
      { name: 'ChatGPT', desc: 'Pro' },
      { name: 'Google One', desc: '2TB' },
      { name: 'iCloud', desc: '200GB' },
      { name: 'YouTube Premium', desc: '' },
      { name: 'Zoom', desc: 'Business' },
      { name: 'Canva', desc: 'Pro' },
      { name: 'Coursera', desc: 'Annual' },
      { name: 'GorkiFlowers', desc: '' },
    ];

    function randomDate(pastYears: number = 1, futureYears: number = 1) {
      const start = new Date();
      start.setFullYear(start.getFullYear() - pastYears);

      const end = new Date();
      end.setFullYear(end.getFullYear() + futureYears);

      const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
      return date.toISOString().split('T')[0];
    }

    function randomPastDate(pastYears: number = 1) {
      const start = new Date();
      start.setFullYear(start.getFullYear() - pastYears);

      const now = new Date();
      const date = new Date(start.getTime() + Math.random() * (now.getTime() - start.getTime()));
      return date.toISOString().split('T')[0];
    }

    function randomAmount(type: 'monthly' | 'yearly') {
      return type === 'monthly'
        ? +(Math.random() * 50 + 5).toFixed(0)
        : +(Math.random() * 500 + 50).toFixed(0);
    }

    const subscribes: SubscribeItem[] = Array.from({ length: 100 }, (_, id) => {
      const service = services[Math.floor(Math.random() * services.length)];
      const type: 'monthly' | 'yearly' = Math.random() > 0.7 ? 'yearly' : 'monthly';

      return {
        id,
        amount: randomAmount(type),
        subscribeDate: randomDate(),
        lastCharge: randomPastDate(),
        subscribeName: service.name,
        type,
        description: service.desc,
      };
    });

    subscribes.push(
      {
        id: 100,
        amount: 500,
        subscribeDate: '2025-10-17',
        lastCharge: '2025-09-17',
        subscribeName: 'Figma',
        type: 'monthly',
        description: 'Pro',
      },
      {
        id: 101,
        amount: 2301,
        subscribeDate: '2025-10-19',
        lastCharge: '2024-10-19',
        subscribeName: 'GorkiFlowers',
        type: 'yearly',
        description: 'Full Suite',
      },
      {
        id: 102,
        amount: 112,
        subscribeDate: '2025-10-18',
        lastCharge: '2025-09-18',
        subscribeName: 'GitHub',
        type: 'monthly',
        description: 'Team',
      },
    );

    return subscribes;
  }
}
