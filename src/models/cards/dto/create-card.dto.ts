import { IsString, IsNumber, IsOptional, Min, MaxLength } from 'class-validator';

export class CreateCardDto {
  @IsString()
  userId: string;

  @IsString()
  @MaxLength(255)
  cardName: string;

  @IsString()
  @MaxLength(20)
  cardNumber: string;

  @IsString()
  @MaxLength(100)
  cardType: string;

  @IsString()
  @MaxLength(255)
  bankName: string;

  @IsString()
  @MaxLength(255)
  branchName: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cardBalance?: number;
}
