import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(6, { message: 'Текущий пароль не менее 6 символов' })
  oldPassword: string;

  @IsString()
  @MinLength(6, { message: 'Новый пароль не менее 6 символов' })
  newPassword: string;
}
