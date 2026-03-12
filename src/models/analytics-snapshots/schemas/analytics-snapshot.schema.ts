import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ExpensesOverviewDto, CategoryLineChartDto } from '@/types';

export type AnalyticsSnapshotDocument = AnalyticsSnapshot & Document;

@Schema({ timestamps: true, collection: 'analytics_snapshots' })
export class AnalyticsSnapshot {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, enum: ['week', 'month', 'quarter'] })
  periodType: string;

  @Prop({ required: true })
  periodStart: Date;

  @Prop({ required: true })
  periodEnd: Date;

  @Prop({ type: Object, required: true })
  overview: ExpensesOverviewDto;

  @Prop({ type: Array, default: [] })
  categoryLineCharts: CategoryLineChartDto[];

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const AnalyticsSnapshotSchema =
  SchemaFactory.createForClass(AnalyticsSnapshot);

AnalyticsSnapshotSchema.index({ userId: 1, periodStart: 1 });
AnalyticsSnapshotSchema.index({ userId: 1, createdAt: -1 });
