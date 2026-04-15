import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateGroupTransactionDto {
  @IsOptional()
  @IsString()
  paidBy?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsString()
  @IsIn(['BYN', 'USD', 'EUR', 'RUB'])
  currencyCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsIn(['expense', 'revenue', 'transfer'])
  type?: 'expense' | 'revenue' | 'transfer';

  /** Личная карта плательщика (при наличии колонки в БД). */
  @IsOptional()
  @IsNumber()
  @Min(1)
  cardId?: number;

  /** При type = transfer — карта зачисления. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  transferToCardId?: number;

  @IsOptional()
  @IsBoolean()
  affectsCardBalance?: boolean;
}
