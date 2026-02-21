import { IsEmail, IsString, MinLength, IsOptional, IsObject } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Некорректный email' })
  email: string;

  @IsString()
  @MinLength(6, { message: 'Пароль не менее 6 символов' })
  password: string;

  @IsOptional()
  @IsObject()
  pushSubscription?: unknown;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
