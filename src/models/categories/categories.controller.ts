import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryItem } from '@/types';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  getCategories() {
    return this.categoriesService.getCategories();
  }

  @Post()
  createCategory(@Body() category: CreateCategoryItem) {
    return this.categoriesService.createCategory(category);
  }

  @Patch(':id')
  updateCategory(@Body() category: CreateCategoryItem, @Param('id') id: number) {
    return this.categoriesService.updateCategory(Number(id), category);
  }

  @Delete(':id')
  deleteCategory(@Param('id') id: number) {
    return this.categoriesService.deleteCategory(Number(id));
  }
}
