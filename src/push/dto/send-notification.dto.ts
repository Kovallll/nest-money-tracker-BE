import { IsString, IsUUID, MaxLength } from 'class-validator';

export class SendNotificationDto {
  @IsUUID('4', { message: 'userId должен быть UUID' })
  userId: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  body: string;
}
