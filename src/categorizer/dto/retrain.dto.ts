import { IsBoolean, IsOptional } from 'class-validator';

export class RetrainDto {
  @IsOptional()
  @IsBoolean()
  full?: boolean;
}
