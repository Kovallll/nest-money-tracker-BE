import { IsString, IsOptional, MaxLength, IsEmail, IsIn, IsBoolean } from 'class-validator';

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
  @IsEmail({}, { message: 'Некорректный email' })
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @IsIn(['week', 'month', 'quarter'], {
    message: 'analytics_snapshot_periodicity must be one of: week, month, quarter',
  })
  analytics_snapshot_periodicity?: 'week' | 'month' | 'quarter';

  @IsOptional()
  @IsBoolean()
  analytics_snapshots_enabled?: boolean;
}
