import {
  IsString,
  IsNumber,
  IsOptional,
  IsDateString,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateGoalDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsNumber()
  @Min(0, { message: 'targetBudget не может быть отрицательным' })
  targetBudget: number;

  @IsNumber()
  @Min(0, { message: 'goalBudget не может быть отрицательным' })
  goalBudget: number;

  @IsOptional()
  @IsDateString({}, { message: 'startDate в формате YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: 'endDate в формате YYYY-MM-DD' })
  endDate?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
