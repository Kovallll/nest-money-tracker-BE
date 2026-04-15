import {
  IsString,
  IsNumber,
  IsOptional,
  IsIn,
  Min,
  MaxLength,
  IsDateString,
  IsBoolean,
} from 'class-validator';

export class UpdateTransactionDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  cardId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsIn(['expense', 'revenue', 'transfer'], {
    message: 'type должен быть expense, revenue или transfer',
  })
  type?: 'expense' | 'revenue' | 'transfer';

  @IsOptional()
  @IsString()
  transferToCardId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'Сумма должна быть больше 0' })
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString({}, { message: 'date в формате YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsString()
  @IsIn(['BYN', 'USD', 'EUR', 'RUB'])
  currencyCode?: string;

  @IsOptional()
  @IsString()
  @IsIn(['cash', 'card'])
  paymentMethod?: 'cash' | 'card';

  @IsOptional()
  @IsBoolean()
  affectsCardBalance?: boolean;

  @IsOptional()
  @IsString()
  predictionKey?: string;

  @IsOptional()
  @IsString()
  predictedCategoryId?: string;
}
