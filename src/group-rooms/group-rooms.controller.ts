import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Patch,
  Post,
  Req,
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { GroupRoomsService } from './group-rooms.service';
import {
  CreateGroupInviteDto,
  CreateGroupRoomDto,
  CreateGroupTransactionDto,
  UpdateGroupMemberRoleDto,
  UpdateGroupRoomDto,
  UpdateGroupTransactionDto,
} from './dto';
import { GroupRoomsEventsService } from './group-rooms-events.service';

@Controller('group-rooms')
@UseGuards(JwtAuthGuard)
export class GroupRoomsController {
  constructor(
    private readonly groupRoomsService: GroupRoomsService,
    private readonly groupRoomsEvents: GroupRoomsEventsService,
  ) {}

  @Sse('events')
  streamEvents(@Req() req: any, @Res() res: any): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const stream$ = this.groupRoomsEvents.streamForUser(req.user.id);
      const sub: Subscription = stream$.subscribe(subscriber);
      req.on('close', () => {
        sub.unsubscribe();
        this.groupRoomsEvents.closeUserStream(req.user.id);
      });
      res.on?.('close', () => {
        sub.unsubscribe();
        this.groupRoomsEvents.closeUserStream(req.user.id);
      });
      return () => {
        sub.unsubscribe();
        this.groupRoomsEvents.closeUserStream(req.user.id);
      };
    });
  }

  @Post()
  createRoom(@Req() req: any, @Body() dto: CreateGroupRoomDto) {
    return this.groupRoomsService.createRoom(req.user.id, dto);
  }

  @Get()
  getMyRooms(@Req() req: any) {
    return this.groupRoomsService.getMyRooms(req.user.id);
  }

  /** Статичные сегменты до общего `:roomId`, иначе часть клиентов/прокси может отдавать неверный маршрут. */
  @Get(':roomId/contributions')
  getRoomContributions(@Req() req: any, @Param('roomId') roomId: string) {
    return this.groupRoomsService.getRoomContributions(roomId, req.user.id);
  }

  @Get(':roomId/transactions')
  getRoomTransactions(@Req() req: any, @Param('roomId') roomId: string) {
    return this.groupRoomsService.getRoomTransactions(roomId, req.user.id);
  }

  @Get(':roomId')
  getRoomDetails(@Req() req: any, @Param('roomId') roomId: string) {
    return this.groupRoomsService.getRoomDetails(roomId, req.user.id);
  }

  @Patch(':roomId')
  updateRoom(
    @Req() req: any,
    @Param('roomId') roomId: string,
    @Body() dto: UpdateGroupRoomDto,
  ) {
    return this.groupRoomsService.updateRoom(roomId, req.user.id, dto);
  }

  @Delete(':roomId')
  deleteRoom(@Req() req: any, @Param('roomId') roomId: string) {
    return this.groupRoomsService.deleteRoom(roomId, req.user.id);
  }

  @Post(':roomId/invites')
  createInvite(
    @Req() req: any,
    @Param('roomId') roomId: string,
    @Body() dto: CreateGroupInviteDto,
  ) {
    return this.groupRoomsService.createInvite(roomId, req.user.id, dto);
  }

  @Post('invites/:token/accept')
  acceptInvite(@Req() req: any, @Param('token') token: string) {
    return this.groupRoomsService.acceptInvite(token, req.user.id);
  }

  @Post('invites/:token/reject')
  rejectInvite(@Param('token') token: string) {
    return this.groupRoomsService.rejectInvite(token);
  }

  @Patch(':roomId/members/:userId/role')
  updateMemberRole(
    @Req() req: any,
    @Param('roomId') roomId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateGroupMemberRoleDto,
  ) {
    return this.groupRoomsService.updateMemberRole(roomId, userId, req.user.id, dto);
  }

  @Delete(':roomId/members/:userId')
  removeMember(@Req() req: any, @Param('roomId') roomId: string, @Param('userId') userId: string) {
    return this.groupRoomsService.removeMember(roomId, userId, req.user.id);
  }

  @Post(':roomId/transactions')
  createRoomTransaction(
    @Req() req: any,
    @Param('roomId') roomId: string,
    @Body() dto: CreateGroupTransactionDto,
  ) {
    return this.groupRoomsService.createRoomTransaction(roomId, req.user.id, dto);
  }

  @Patch(':roomId/transactions/:transactionId')
  updateRoomTransaction(
    @Req() req: any,
    @Param('roomId') roomId: string,
    @Param('transactionId') transactionId: string,
    @Body() dto: UpdateGroupTransactionDto,
  ) {
    return this.groupRoomsService.updateRoomTransaction(roomId, transactionId, req.user.id, dto);
  }

  @Delete(':roomId/transactions/:transactionId')
  deleteRoomTransaction(
    @Req() req: any,
    @Param('roomId') roomId: string,
    @Param('transactionId') transactionId: string,
  ) {
    return this.groupRoomsService.deleteRoomTransaction(roomId, transactionId, req.user.id);
  }
}
