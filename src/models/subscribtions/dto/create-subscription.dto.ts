import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
  Min,
  MaxLength,
} from 'class-validator';

export class CreateSubscriptionDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsString()
  @MaxLength(255)
  subscribeName: string;

  @IsDateString({}, { message: 'subscribeDate в формате YYYY-MM-DD' })
  subscribeDate: string;

  @IsNumber()
  @Min(0, { message: 'amount не может быть отрицательным' })
  amount: number;

  @IsOptional()
  @IsDateString()
  lastCharge?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
