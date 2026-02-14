import { Injectable, NotFoundException } from '@nestjs/common';
import { SubscribeItem } from '@/types';

@Injectable()
export class SubscribtionsService {
  private subscribes: SubscribeItem[] = [];

  constructor() {
    this.subscribes = this.generateInitialSubscribes();
  }

  getAll(): SubscribeItem[] {
    return this.subscribes;
  }

  getById(id: number): SubscribeItem {
    const item = this.subscribes.find((s) => s.id === String(id));
    if (!item) throw new NotFoundException(`Subscription with id=${id} not found`);
    return item;
  }

  create(data: Omit<SubscribeItem, 'id'>): SubscribeItem {
    // Ensure ids are compared as numbers for max
    const id = this.subscribes.length
      ? Math.max(...this.subscribes.map((s) => Number(s.id))) + 1
      : 1;
    const newSub: SubscribeItem = { id: String(id), ...data };
    this.subscribes.push(newSub);
    return newSub;
  }

  update(id: number, data: Partial<SubscribeItem>): SubscribeItem {
    const index = this.subscribes.findIndex((s) => s.id === String(id));
    if (index === -1) throw new NotFoundException(`Subscription with id=${id} not found`);
    this.subscribes[index] = { ...this.subscribes[index], ...data };
    return this.subscribes[index];
  }

  delete(id: number): void {
    const index = this.subscribes.findIndex((s) => s.id === String(id));
    if (index === -1) throw new NotFoundException(`Subscription with id=${id} not found`);
    this.subscribes.splice(index, 1);
  }

  private generateInitialSubscribes(): SubscribeItem[] {
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

    const now = new Date();

    function randomFutureDate(daysAhead = 21) {
      const future = new Date(now);
      future.setDate(now.getDate() + Math.floor(Math.random() * daysAhead) + 1);
      return future.toISOString().split('T')[0];
    }

    function randomPastDate(daysBack = 30) {
      const past = new Date(now);
      past.setDate(now.getDate() - Math.floor(Math.random() * daysBack) - 1);
      return past.toISOString().split('T')[0];
    }

    function randomAmount(type: 'monthly' | 'yearly') {
      return type === 'monthly'
        ? +(Math.random() * 50 + 5).toFixed(0)
        : +(Math.random() * 500 + 50).toFixed(0);
    }

    const subscribes: SubscribeItem[] = Array.from({ length: 30 }, (_, id) => {
      const service = services[Math.floor(Math.random() * services.length)];
      const type: 'monthly' | 'yearly' = Math.random() > 0.7 ? 'yearly' : 'monthly';

      const isFuture = Math.random() < 0.4; // 40% подписок — с будущей датой

      return {
        id: String(id),
        amount: randomAmount(type),
        subscribeDate: isFuture ? randomFutureDate() : randomPastDate(),
        lastCharge: randomPastDate(),
        subscribeName: service.name,
        type,
        description: service.desc,
      };
    });

    return subscribes;
  }
}

