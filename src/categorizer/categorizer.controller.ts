import { Body, Controller, Post, Get, UseGuards } from '@nestjs/common';
import { CategorizerService, Prediction } from './categorizer.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { PredictCategoryDto, RetrainDto } from './dto';

@Controller('categorizer')
@UseGuards(JwtAuthGuard)
export class CategorizerController {
  constructor(private readonly categorizerService: CategorizerService) {}

  @Post('predict')
  predictCategory(@Body() body: PredictCategoryDto): Promise<Prediction> {
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
}
