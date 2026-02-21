import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

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
}
