import {
  IsString,
  IsNumber,
  IsOptional,
  IsIn,
  Min,
  MaxLength,
  IsDateString,
  IsBoolean,
  ValidateIf,
} from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  userId: string;

  @IsString()
  cardId: string;

  @ValidateIf((o: CreateTransactionDto) => o.type !== 'transfer')
  @IsString()
  categoryId?: string;

  @ValidateIf((o: CreateTransactionDto) => o.type === 'transfer')
  @IsString()
  transferToCardId: string;

  @IsIn(['expense', 'revenue', 'transfer'], {
    message: 'type должен быть expense, revenue или transfer',
  })
  type: 'expense' | 'revenue' | 'transfer';

  @IsNumber()
  @Min(0.01, { message: 'Сумма должна быть больше 0' })
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString({}, { message: 'date в формате YYYY-MM-DD' })
  date: string;

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

  /** Redis cache key from categorizer/predict (for feedback: was prediction accepted). */
  @IsOptional()
  @IsString()
  predictionKey?: string;

  /** Category id that was predicted (primary or chosen alternative). */
  @IsOptional()
  @IsString()
  predictedCategoryId?: string;
}

