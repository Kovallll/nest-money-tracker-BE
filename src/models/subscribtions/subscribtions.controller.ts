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
import { SubscribtionsService } from './subscribtions.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from './dto';

@Controller('subscribtions')
@UseGuards(JwtAuthGuard)
export class SubscribtionsController {
  constructor(private readonly subscribtionsService: SubscribtionsService) {}

  @Get()
  getAll() {
    return this.subscribtionsService.getAll();
  }

  @Get('user/:userId')
  getByUserId(@Param('userId') userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException(
        'Укажите userId в пути: GET /api/subscribtions/user/:userId (например, UUID пользователя).',
      );
    }
    return this.subscribtionsService.getByUserId(userId.trim());
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const item = await this.subscribtionsService.getById(id);
    if (!item) throw new NotFoundException(`Subscription with id=${id} not found`);
    return item;
  }

  @Post()
  create(@Body() dto: CreateSubscriptionDto) {
    return this.subscribtionsService.create({
      ...dto,
      type: dto.type ?? '',
      lastCharge: dto.lastCharge ?? null,
      isActive: dto.isActive ?? true,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSubscriptionDto) {
    return this.subscribtionsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.subscribtionsService.delete(id);
  }
}

