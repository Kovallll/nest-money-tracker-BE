import { IsString, IsNumber, IsOptional, Min, MaxLength } from 'class-validator';

export class UpdateCardDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  cardName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cardNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cardType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  branchName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cardBalance?: number;
}
