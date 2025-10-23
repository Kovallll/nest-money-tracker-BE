import { Controller, Get } from '@nestjs/common';
import { SubscribtionsService } from './subscribtions.service';

@Controller('subscribtions')
export class SubscribtionsController {
  constructor(private readonly subscribtionsService: SubscribtionsService) {}

  @Get()
  getSubscribtions() {
    return this.subscribtionsService.getSubscribes();
  }
}
