import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { GoalsService } from './goals.service';
import { GoalItem } from '@/types';

@Controller('goals')
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Get()
  getAll() {
    return this.goalsService.getGoals();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.goalsService.getGoalById(+id);
  }

  @Post()
  create(@Body() data: Omit<GoalItem, 'id'>) {
    return this.goalsService.createGoal(data);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() data: Partial<GoalItem>) {
    return this.goalsService.updateGoal(+id, data);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.goalsService.deleteGoal(+id);
  }
}
