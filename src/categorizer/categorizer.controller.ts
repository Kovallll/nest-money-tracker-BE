import {
  Body,
  Controller,
  Post,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { CategorizerService, Prediction } from './categorizer.service';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { PredictCategoryDto, RetrainDto } from './dto';

@Controller('categorizer')
@UseGuards(JwtAuthGuard)
export class CategorizerController {
  private readonly logger = new Logger(CategorizerController.name);

  constructor(private readonly categorizerService: CategorizerService) {}

  @Post('predict')
  async predictCategory(@Body() body: PredictCategoryDto): Promise<Prediction> {
    try {
      const prediction = await this.categorizerService.predict(body.text);
      return prediction;
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Ошибка предсказания: ${error.message}`);
      throw new HttpException(
        'Не удалось получить предсказание от ML сервиса',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Post('retrain')
  async forceRetrain(@Body() body: RetrainDto) {
    try {
      return await this.categorizerService.forceRetrain(body.full ?? false);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Ошибка переобучения: ${error.message}`);
      throw new HttpException('ML сервис недоступен', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Get('status')
  async getStatus() {
    try {
      return await this.categorizerService.getStatus();
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Ошибка получения статуса: ${error.message}`);
      throw new HttpException('ML сервис недоступен', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
