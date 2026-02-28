import { IsString, IsOptional, IsArray, MaxLength, IsIn } from 'class-validator';
import { VALID_CATEGORY_ICONS } from '../valid-icons.const';

export class CreateCategoryDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @IsIn([...VALID_CATEGORY_ICONS])
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  examples?: string[];
}
