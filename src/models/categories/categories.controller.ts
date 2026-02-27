import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  BadRequestException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { CreateCategoryDto, UpdateCategoryDto, AddExampleDto } from './dto';

@Controller('categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  getCategories() {
    return this.categoriesService.getCategories();
  }

  @Get('user/:userId')
  getCategoriesByUserId(@Param('userId') userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException(
        'Укажите userId в пути: GET /api/categories/user/:userId (например, UUID пользователя).',
      );
    }
    return this.categoriesService.getCategoriesByUserId(userId.trim());
  }

  @Get(':id')
  getCategory(@Param('id') id: string) {
    return this.categoriesService.getCategoryByIdOrThrow(id);
  }

  @Post()
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.createCategory(dto);
  }

  @Patch(':id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.updateCategory(id, dto);
  }

  @Delete(':id')
  async deleteCategory(
    @Param('id') id: string,
    @Query('reassignTo') reassignTo?: string,
  ) {
    await this.categoriesService.deleteCategory(id, reassignTo?.trim() || undefined);
    return { deleted: true };
  }

  @Post(':id/examples')
  async addExample(@Param('id') categoryId: string, @Body() body: AddExampleDto) {
    await this.categoriesService.addExample(categoryId, body.example.trim());
    return { added: true, example: body.example.trim() };
  }

  @Get(':id/examples')
  getExamples(@Param('id') categoryId: string) {
    return this.categoriesService.getExamples(categoryId);
  }
}
