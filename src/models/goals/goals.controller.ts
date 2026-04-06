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
import { GoalsService } from './goals.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateGoalDto, UpdateGoalDto } from './dto';
import { RoomMembershipService } from '@/common/room-membership.service';

@Controller('goals')
@UseGuards(JwtAuthGuard)
export class GoalsController {
  constructor(
    private readonly goalsService: GoalsService,
    private readonly roomMembership: RoomMembershipService,
  ) {}

  @Get()
  getAll() {
    return this.goalsService.getGoals();
  }

  @Get('room/:roomId')
  getByRoomId(@Param('roomId') roomId: string, @Req() req: any) {
    if (!roomId?.trim()) {
      throw new BadRequestException('Укажите roomId');
    }
    return this.goalsService.getGoalsByRoomIdForMember(roomId.trim(), req.user.id);
  }

  @Get('user/:userId')
  getByUserId(@Param('userId') userId: string, @Req() req: any) {
    if (!userId?.trim()) {
      throw new BadRequestException(
        'Укажите userId в пути: GET /api/goals/user/:userId (например, UUID пользователя).',
      );
    }
    const uid = userId.trim();
    this.roomMembership.assertPersonalAccess(uid, req.user.id, req.user?.isService);
    return this.goalsService.getGoalsByUserId(uid);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.goalsService.getGoalByIdForRequester(id, req.user.id, req.user?.isService);
  }

  @Post()
  create(@Body() dto: CreateGoalDto, @Req() req: any) {
    return this.goalsService.createGoal(dto, req.user.id, req.user?.isService);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGoalDto, @Req() req: any) {
    return this.goalsService.updateGoal(id, dto, req.user.id, req.user?.isService);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string, @Req() req: any) {
    return this.goalsService.deleteGoal(id, req.user.id, req.user?.isService);
  }
}
