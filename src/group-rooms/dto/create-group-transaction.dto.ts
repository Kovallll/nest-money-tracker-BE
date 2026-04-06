import { IsDateString, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateGroupTransactionDto {
  @IsOptional()
  @IsString()
  paidBy?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Личная карта пользователя {@link paidBy} (по умолчанию — создатель); списание баланса как у расхода. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  cardId?: number;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  @IsIn(['BYN', 'USD', 'EUR', 'RUB'])
  currencyCode?: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  date: string;
}
