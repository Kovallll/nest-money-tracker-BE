import { IsIn, IsOptional } from 'class-validator';

export class QueryInsightsDto {
  @IsOptional()
  @IsIn(['active', 'acknowledged', 'dismissed', 'expired'])
  status?: 'active' | 'acknowledged' | 'dismissed' | 'expired';

  @IsOptional()
  @IsIn(['anomaly', 'overspend', 'budget_tip', 'fx_signal', 'investment_signal', 'system'])
  type?: 'anomaly' | 'overspend' | 'budget_tip' | 'fx_signal' | 'investment_signal' | 'system';
}

