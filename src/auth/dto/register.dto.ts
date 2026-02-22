import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Некорректный email' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Пароль не менее 6 символов' })
  @MaxLength(100)
  password: string;

  @IsString()
  @MinLength(1, { message: 'Имя обязательно' })
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lastname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;
}
