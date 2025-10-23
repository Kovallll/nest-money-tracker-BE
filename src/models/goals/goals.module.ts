import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';

@Module({
  providers: [GoalsService],
  controllers: [GoalsController],
})
export class GoalsModule {}
