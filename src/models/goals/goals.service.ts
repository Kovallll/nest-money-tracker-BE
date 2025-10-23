import { GoalItem } from '@/types';
import { Injectable } from '@nestjs/common';

@Injectable()
export class GoalsService {
  getGoals() {
    const titles = [
      'Car',
      'House',
      'Travel',
      'Education',
      'Wedding',
      'Business',
      'Renovation',
      'Vacation',
      'Gadget',
      'Medical Fund',
      'Retirement',
      'Emergency Fund',
      'Furniture',
      'Charity',
      'Electronics',
      'New Bike',
      'Boat',
      'Camera',
      'Gaming PC',
      'Musical Instrument',
    ];

    function randomTitle(id: number) {
      return titles[id % titles.length] + ' ' + (Math.floor(id / titles.length) + 1);
    }

    function randomDate(futureYears: number = 3) {
      const start = new Date();
      const end = new Date();
      end.setFullYear(end.getFullYear() + futureYears);

      const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
      return date.toISOString().split('T')[0]; // YYYY-MM-DD
    }

    const goals: GoalItem[] = Array.from({ length: 600 }, (_, id) => {
      const startDate = randomDate(2); // в пределах 2 лет от сегодня
      const endDate = randomDate(5); // в пределах 5 лет от сегодня

      const targetBudget = +(Math.random() * 50 + 1).toFixed(2);
      const goalBudget = +(targetBudget + Math.random() * 100).toFixed(2);

      return {
        id,
        targetBudget,
        goalBudget,
        startDate,
        endDate,
        title: randomTitle(id),
      };
    });

    return goals;
  }
}
