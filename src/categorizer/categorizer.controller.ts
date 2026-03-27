import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { CategorizerService, PredictionResponse } from './categorizer.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { PredictCategoryDto, RetrainDto } from './dto';
import { PredictionCacheService } from './prediction-cache.service';

@Controller('categorizer')
@UseGuards(JwtAuthGuard)
export class CategorizerController {
  constructor(
    private readonly categorizerService: CategorizerService,
    private readonly predictionCache: PredictionCacheService,
  ) {}

  @Post('predict')
  predictCategory(@Body() body: PredictCategoryDto): Promise<PredictionResponse> {
    return this.categorizerService.predict(body.text);
  }

  @Post('retrain')
  forceRetrain(@Body() body: RetrainDto) {
    return this.categorizerService.forceRetrain(body.full ?? false);
  }

  @Get('status')
  getStatus() {
    return this.categorizerService.getStatus();
  }

  @Delete('cache')
  async flushCache(): Promise<{ deleted: number }> {
    const deleted = await this.predictionCache.flushCacheByPrefix('ml:predict:*');
    return { deleted };
  }
}
