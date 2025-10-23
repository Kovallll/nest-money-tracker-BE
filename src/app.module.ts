import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CardsModule } from './models/cards/cards.module';
import { TransactionsModule } from './models/transactions/transactions.module';
import { GoalsModule } from './models/goals/goals.module';
import { ExpensesModule } from './models/expenses/expenses.module';
import { StatisticsModule } from './models/statistics/statistics.module';
import { SubscribtionsModule } from './models/subscribtions/subscribtions.module';
import { UserModule } from './models/user/user.module';
import { CategoriesModule } from './models/categories/categories.module';

@Module({
  controllers: [AppController],
  providers: [AppService],
  imports: [
    CardsModule,
    TransactionsModule,
    GoalsModule,
    ExpensesModule,
    StatisticsModule,
    SubscribtionsModule,
    UserModule,
    CategoriesModule,
  ],
})
export class AppModule {}
