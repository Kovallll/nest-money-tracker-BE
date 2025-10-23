import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { ExpensesService } from '../expenses/expenses.service';

@Module({
  providers: [CategoriesService, ExpensesService],
  controllers: [CategoriesController],
})
export class CategoriesModule {}
