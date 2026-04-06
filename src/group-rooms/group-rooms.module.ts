import { Module } from '@nestjs/common';
import { TransactionsModule } from '@/models/transactions/transactions.module';
import { GroupRoomsController } from './group-rooms.controller';
import { GroupRoomsService } from './group-rooms.service';
import { GroupRoomsEventsService } from './group-rooms-events.service';

@Module({
  imports: [TransactionsModule],
  controllers: [GroupRoomsController],
  providers: [GroupRoomsService, GroupRoomsEventsService],
  exports: [GroupRoomsService, GroupRoomsEventsService],
})
export class GroupRoomsModule {}
