import { IsString, IsOptional, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lastname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
