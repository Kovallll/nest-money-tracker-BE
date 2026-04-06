import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  BadRequestException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateCategoryDto } from './dto';

@Controller('categories/room')
@UseGuards(JwtAuthGuard)
export class CategoriesRoomController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get(':roomId')
  getCategoriesByRoomId(@Param('roomId') roomId: string, @Req() req: any) {
    if (!roomId?.trim()) {
      throw new BadRequestException('Укажите roomId');
    }
    return this.categoriesService.getCategoriesByRoomIdForMember(roomId.trim(), req.user.id);
  }

  @Post(':roomId')
  createCategoryForRoom(
    @Param('roomId') roomId: string,
    @Body() dto: CreateCategoryDto,
    @Req() req: any,
  ) {
    if (!roomId?.trim()) throw new BadRequestException('Укажите roomId');
    return this.categoriesService.createCategoryForRoom(
      roomId.trim(),
      {
        name: dto.name,
        icon: dto.icon,
        color: dto.color,
        examples: dto.examples,
      },
      req.user.id,
    );
  }
}

