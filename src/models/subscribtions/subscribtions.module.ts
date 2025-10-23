import { Module } from '@nestjs/common';
import { SubscribtionsService } from './subscribtions.service';
import { SubscribtionsController } from './subscribtions.controller';

@Module({
  controllers: [SubscribtionsController],
  providers: [SubscribtionsService],
})
export class SubscribtionsModule {}
