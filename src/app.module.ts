import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CardsModule } from './models/cards/cards.module';
import { TransactionsModule } from './models/transactions/transactions.module';
import { GoalsModule } from './models/goals/goals.module';
import { StatisticsModule } from './models/statistics/statistics.module';
import { SubscribtionsModule } from './models/subscribtions/subscribtions.module';
import { UsersModule } from './users/users.module';
import { CategoriesModule } from './models/categories/categories.module';
import { PgModule } from './pg/pg.module';
import { ConfigModule } from '@nestjs/config';
import { CategorizerModule } from './categorizer/categorizer.module';
import { AuthModule } from './auth/auth.module';
import { PushModule } from './push/push.module';
import { TelegramModule } from './telegram/telegram.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalyticsSnapshotsModule } from './models/analytics-snapshots/analytics-snapshots.module';

@Module({
  controllers: [AppController, HealthController],
  providers: [AppService, HealthService],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGODB_URI || 'mongodb://localhost:27017/finance'),
    ScheduleModule.forRoot(),
    CardsModule,
    TransactionsModule,
    GoalsModule,
    StatisticsModule,
    SubscribtionsModule,
    UsersModule,
    CategoriesModule,
    PgModule,
    CategorizerModule,
    AuthModule,
    PushModule,
    TelegramModule,
    AnalyticsSnapshotsModule,
  ],
})
export class AppModule {}

