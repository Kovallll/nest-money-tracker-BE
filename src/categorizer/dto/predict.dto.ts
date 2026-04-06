import { IsString, IsOptional, IsUUID, MinLength } from 'class-validator';

export class PredictCategoryDto {
  @IsString()
  @MinLength(1, { message: 'Текст обязателен' })
  text: string;

  @IsOptional()
  @IsUUID('4')
  userId?: string;

  /** Комната: подбор категории среди категорий комнаты + глобальных шаблонов. */
  @IsOptional()
  @IsUUID('4')
  roomId?: string;
}
