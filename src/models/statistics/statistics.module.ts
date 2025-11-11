import { Module } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { CategoriesModule } from '../categories/categories.module';
import { StatisticsController } from './statistics.controller';
import { TransactionsService } from '../transactions/transactions.service';

@Module({
  controllers: [StatisticsController],
  providers: [StatisticsService, TransactionsService],
  imports: [CategoriesModule],
})
export class StatisticsModule {}
