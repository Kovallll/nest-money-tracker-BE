import { Global, Module } from '@nestjs/common';
import { RoomMembershipService } from './room-membership.service';

@Global()
@Module({
  providers: [RoomMembershipService],
  exports: [RoomMembershipService],
})
export class CommonModule {}
