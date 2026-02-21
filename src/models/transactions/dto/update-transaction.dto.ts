import {
  IsString,
  IsNumber,
  IsOptional,
  IsIn,
  Min,
  MaxLength,
  IsDateString,
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
  @IsIn(['expense', 'revenue'], { message: 'type должен быть expense или revenue' })
  type?: 'expense' | 'revenue';

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
}
