import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { SubscribtionsService } from './subscribtions.service';
import { SubscribeItem } from '@/types';

@Controller('subscribtions')
export class SubscribtionsController {
  constructor(private readonly subscribtionsService: SubscribtionsService) {}

  @Get()
  getAll() {
    return this.subscribtionsService.getAll();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.subscribtionsService.getById(Number(id));
  }

  @Post()
  create(@Body() dto: Omit<SubscribeItem, 'id'>) {
    return this.subscribtionsService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<SubscribeItem>) {
    return this.subscribtionsService.update(Number(id), dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.subscribtionsService.delete(Number(id));
    return { message: `Subscription ${id} deleted successfully` };
  }
}
