import { Controller, Get } from '@nestjs/common';
import { Public } from '@/common/decorators';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  check() {
    return this.healthService.check();
  }
}

