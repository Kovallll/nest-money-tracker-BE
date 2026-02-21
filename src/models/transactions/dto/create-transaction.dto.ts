import {
  IsString,
  IsNumber,
  IsOptional,
  IsIn,
  Min,
  MaxLength,
  IsDateString,
} from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  userId: string;

  @IsString()
  cardId: string;

  @IsString()
  categoryId: string;

  @IsIn(['expense', 'revenue'], { message: 'type должен быть expense или revenue' })
  type: 'expense' | 'revenue';

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
}
