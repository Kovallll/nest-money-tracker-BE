import { IsIn } from 'class-validator';

export class AckInsightDto {
  @IsIn(['acknowledged', 'dismissed'])
  status: 'acknowledged' | 'dismissed';
}

