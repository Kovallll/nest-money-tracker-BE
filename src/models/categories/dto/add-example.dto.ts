import { IsString, MinLength } from 'class-validator';

export class AddExampleDto {
  @IsString()
  @MinLength(1, { message: 'Пример не может быть пустым' })
  example: string;
}
