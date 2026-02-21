import { IsObject, IsOptional, IsString } from 'class-validator';

export class SubscribePushDto {
  @IsObject()
  subscription: unknown;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
