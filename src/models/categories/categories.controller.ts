import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  HttpException,
  HttpStatus,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategorizerService } from '@/categorizer/categorizer.service';
import { CreateCategoryItem } from '@/types';

@Controller('categories')
export class CategoriesController implements OnModuleInit {
  private readonly logger = new Logger(CategoriesController.name);

  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly categorizerService: CategorizerService,
  ) {}

  async onModuleInit() {
    // Инициализация базовых категорий при старте
    await this.categoriesService.initDatabase();

    // Уведомляем ML о новых данных
    try {
      await this.categorizerService.forceRetrain();
    } catch (e) {
      this.logger.warn('ML сервис недоступен, будет использован watcher');
    }
  }

  @Get()
  async getCategories() {
    return await this.categoriesService.getCategories();
  }

  @Get('user/:userId')
  async getCategoriesByUserId(@Param('userId') userId: string) {
    return this.categoriesService.getCategoriesByUserId(userId);
  }

  @Get(':id')
  async getCategory(@Param('id') id: string) {
    const category = await this.categoriesService.getCategoryById(id);
    if (!category) {
      throw new HttpException('Категория не найдена', HttpStatus.NOT_FOUND);
    }
    return category;
  }

  @Post()
  async createCategory(@Body() category: CreateCategoryItem) {
    try {
      const result = await this.categoriesService.createCategory(category);

      // Уведомляем ML
      this.notifyML();

      return result;
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Patch(':id')
  async updateCategory(@Param('id') id: string, @Body() category: Partial<CreateCategoryItem>) {
    try {
      const result = await this.categoriesService.updateCategory(id, category);

      // Уведомляем ML
      this.notifyML();

      return result;
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':id')
  async deleteCategory(@Param('id') id: string) {
    try {
      const deleted = await this.categoriesService.deleteCategory(id);

      if (!deleted) {
        throw new HttpException('Категория не найдена', HttpStatus.NOT_FOUND);
      }

      // Уведомляем ML
      this.notifyML();

      return { deleted: true };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/examples')
  async addExample(@Param('id') categoryId: string, @Body() body: { example: string }) {
    if (!body.example || body.example.trim().length === 0) {
      throw new HttpException('Пример не может быть пустым', HttpStatus.BAD_REQUEST);
    }

    try {
      await this.categoriesService.addExample(categoryId, body.example.trim());

      // Уведомляем ML
      this.notifyML();

      return { added: true, example: body.example };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get(':id/examples')
  async getExamples(@Param('id') categoryId: string) {
    return this.categoriesService.getExamples(categoryId);
  }

  // Приватный метод для уведомления ML (не блокирует ответ)
  private notifyML(): void {
    this.categorizerService.forceRetrain().catch((err) => {
      this.logger.warn(`Не удалось уведомить ML: ${err.message}`);
    });
  }
}

