import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesRoomController } from './categories-room.controller';
import { CategoriesService } from './categories.service';
import { CategorizerModule } from '@/categorizer/categorizer.module';

@Module({
  imports: [CategorizerModule],
  providers: [CategoriesService],
  controllers: [CategoriesController, CategoriesRoomController],
  exports: [CategoriesService],
})
export class CategoriesModule {}

