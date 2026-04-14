import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubscribePushDto {
  @IsObject()
  subscription: unknown;

  @IsOptional()
  @IsString()
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
