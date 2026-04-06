import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { SubscribtionsService } from './subscribtions.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from './dto';
import { RoomMembershipService } from '@/common/room-membership.service';

@Controller('subscribtions')
@UseGuards(JwtAuthGuard)
export class SubscribtionsController {
  constructor(
    private readonly subscribtionsService: SubscribtionsService,
    private readonly roomMembership: RoomMembershipService,
  ) {}

  @Get()
  getAll() {
    return this.subscribtionsService.getAll();
  }

  @Get('room/:roomId')
  getByRoomId(@Param('roomId') roomId: string, @Req() req: any) {
    if (!roomId?.trim()) throw new BadRequestException('Укажите roomId');
    return this.subscribtionsService.getByRoomIdForMember(roomId.trim(), req.user.id);
  }

  @Get('user/:userId')
  getByUserId(@Param('userId') userId: string, @Req() req: any) {
    if (!userId?.trim()) {
      throw new BadRequestException(
        'Укажите userId в пути: GET /api/subscribtions/user/:userId (например, UUID пользователя).',
      );
    }
    const uid = userId.trim();
    this.roomMembership.assertPersonalAccess(uid, req.user.id, req.user?.isService);
    return this.subscribtionsService.getByUserId(uid);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.subscribtionsService.getByIdForRequester(id, req.user.id, req.user?.isService);
  }

  @Post()
  create(@Body() dto: CreateSubscriptionDto, @Req() req: any) {
    return this.subscribtionsService.create(dto, req.user.id, req.user?.isService);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSubscriptionDto, @Req() req: any) {
    return this.subscribtionsService.update(id, dto, req.user.id, req.user?.isService);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.subscribtionsService.delete(id, req.user.id, req.user?.isService);
  }
}
