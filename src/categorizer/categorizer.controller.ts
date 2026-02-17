import { Body, Controller, Post, Get, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { CategorizerService, Prediction } from './categorizer.service';

@Controller('categorizer')
export class CategorizerController {
  private readonly logger = new Logger(CategorizerController.name);

  constructor(private readonly categorizerService: CategorizerService) {}

  @Post('predict')
  async predictCategory(@Body() body: { text: string; userId?: string }): Promise<Prediction> {
    if (!body.text || body.text.trim().length === 0) {
      throw new HttpException('Текст обязателен', HttpStatus.BAD_REQUEST);
    }

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
  async forceRetrain(@Body() body: { full: boolean }) {
    try {
      return await this.categorizerService.forceRetrain(body.full);
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
