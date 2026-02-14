import { Injectable, NotFoundException } from '@nestjs/common';
import { GoalItem } from '@/types';

@Injectable()
export class GoalsService {
  private goals: GoalItem[] = [];

  constructor() {
    this.goals = this.generateMockGoals();
  }

  private generateMockGoals(): GoalItem[] {
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
      return date.toISOString().split('T')[0];
    }

    return Array.from({ length: 600 }, (_, id) => {
      const startDate = randomDate(2);
      const endDate = randomDate(5);
      const targetBudget = +(Math.random() * 50 + 1).toFixed(2);
      const goalBudget = +(targetBudget + Math.random() * 100).toFixed(2);

      return {
        id: String(id),
        targetBudget,
        goalBudget,
        startDate,
        endDate,
        title: randomTitle(id),
      };
    });
  }

  getGoals(): GoalItem[] {
    return this.goals;
  }

  getGoalById(id: number): GoalItem {
    const goal = this.goals.find((g) => g.id === String(id));
    if (!goal) {
      throw new NotFoundException(`Goal with id ${id} not found`);
    }
    return goal;
  }

  createGoal(data: Omit<GoalItem, 'id'>): GoalItem {
    const id = this.goals.length ? Math.max(...this.goals.map((s) => Number(s.id))) + 1 : 1;
    const newGoal: GoalItem = {
      ...data,
      id: String(id),
    };
    this.goals.push(newGoal);
    return newGoal;
  }

  updateGoal(id: number, data: Partial<GoalItem>): GoalItem {
    const index = this.goals.findIndex((g) => g.id === String(id));
    if (index === -1) {
      throw new NotFoundException(`Goal with id ${id} not found`);
    }
    const updated = { ...this.goals[index], ...data };
    this.goals[index] = updated;
    return updated;
  }

  deleteGoal(id: number): void {
    const index = this.goals.findIndex((g) => g.id === String(id));
    if (index === -1) {
      throw new NotFoundException(`Goal with id ${id} not found`);
    }
    this.goals.splice(index, 1);
  }
}

