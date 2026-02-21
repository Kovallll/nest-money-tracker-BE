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
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { GoalsService } from './goals.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateGoalDto, UpdateGoalDto } from './dto';

@Controller('goals')
@UseGuards(JwtAuthGuard)
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Get()
  getAll() {
    return this.goalsService.getGoals();
  }

  @Get('user/:userId')
  getByUserId(@Param('userId') userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException(
        'Укажите userId в пути: GET /api/goals/user/:userId (например, UUID пользователя).',
      );
    }
    return this.goalsService.getGoalsByUserId(userId.trim());
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const goal = await this.goalsService.getGoalById(id);
    if (!goal) throw new NotFoundException(`Goal with id ${id} not found`);
    return goal;
  }

  @Post()
  create(@Body() dto: CreateGoalDto) {
    return this.goalsService.createGoal({
      ...dto,
      status: dto.status ?? 'active',
      startDate: dto.startDate ?? '',
      endDate: dto.endDate ?? '',
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGoalDto) {
    return this.goalsService.updateGoal(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.goalsService.deleteGoal(id);
  }
}

