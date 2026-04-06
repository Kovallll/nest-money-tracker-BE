import { IsOptional, IsString, MaxLength, IsIn } from 'class-validator';

export class CreateGroupRoomDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar?: string;

  @IsOptional()
  @IsString()
  @IsIn(['BYN', 'USD', 'EUR', 'RUB'])
  currencyCode?: string;
}
