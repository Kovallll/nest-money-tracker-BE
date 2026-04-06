import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class CreateGroupInviteDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 30)
  expiresInHours?: number;
}
