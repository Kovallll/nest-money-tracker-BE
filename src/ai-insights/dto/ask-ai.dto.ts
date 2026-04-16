import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AskAiDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  question: string;

  @IsOptional()
  @IsUUID()
  sessionId?: string;
}

