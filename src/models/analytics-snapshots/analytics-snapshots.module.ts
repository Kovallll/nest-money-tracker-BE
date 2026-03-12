import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AnalyticsSnapshot,
  AnalyticsSnapshotSchema,
} from './schemas/analytics-snapshot.schema';
import { AnalyticsSnapshotsService } from './analytics-snapshots.service';
import { AnalyticsSnapshotsController } from './analytics-snapshots.controller';
import { StatisticsModule } from '../statistics/statistics.module';
import { UsersModule } from '@/users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AnalyticsSnapshot.name, schema: AnalyticsSnapshotSchema },
    ]),
    StatisticsModule,
    UsersModule,
  ],
  controllers: [AnalyticsSnapshotsController],
  providers: [AnalyticsSnapshotsService],
  exports: [AnalyticsSnapshotsService],
})
export class AnalyticsSnapshotsModule {}
