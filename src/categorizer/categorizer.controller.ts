import { Body, Controller, Delete, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
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
  predictCategory(
    @Body() body: PredictCategoryDto,
    @Req() req: { user?: { id?: string } },
  ): Promise<PredictionResponse> {
    return this.categorizerService.predict(body.text, {
      userId: req?.user?.id,
      roomId: body.roomId,
    });
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

  @Get('metrics')
  getMetrics(@Query('days') days?: string) {
    const period = Math.max(1, Number(days || 30) || 30);
    return this.categorizerService.getMetrics(period);
  }
}
