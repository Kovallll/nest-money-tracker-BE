import { Injectable } from '@nestjs/common';
import { PredictionCacheService } from './prediction-cache.service';

@Injectable()
export class PredictionFeedbackService {
  constructor(private readonly predictionCache: PredictionCacheService) {}

  /**
   * Records whether the user accepted the prediction (chose the predicted category) or rejected it.
   * Call after transaction create/update when predictionKey and predictedCategoryId were sent.
   */
  async recordFeedback(
    predictionKey: string,
    predictedCategoryId: string,
    actualCategoryId: string | null,
  ): Promise<void> {
    if (!predictionKey?.trim()) return;
    const isAccepted =
      predictedCategoryId != null &&
      actualCategoryId != null &&
      String(predictedCategoryId).trim() === String(actualCategoryId).trim();
    await this.predictionCache.updateFeedback(predictionKey, isAccepted);
  }
}
