import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CategorizerService } from './categorizer.service';
import { CategorizerController } from './categorizer.controller';
import { PredictionCacheService } from './prediction-cache.service';
import { PredictionFeedbackService } from './prediction-feedback.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
  ],
  controllers: [CategorizerController],
  providers: [CategorizerService, PredictionCacheService, PredictionFeedbackService],
  exports: [CategorizerService, PredictionCacheService, PredictionFeedbackService],
})
export class CategorizerModule {}
