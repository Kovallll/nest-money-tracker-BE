import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';

interface CategorizerGrpcClient {
  predict(data: { text: string; user_id: string }): Observable<any>;
  forceRetrain(data: any): Observable<any>;
  getStatus(data: any): Observable<any>;
}

export interface PredictionResult {
  category_id: string;
  category_name: string;
  category_icon: string;
  category_color: string;
  confidence: number;
}

export interface Prediction {
  primary: PredictionResult;
  alternatives: PredictionResult[];
  needs_confirmation: boolean;
  source: string;
}

@Injectable()
export class CategorizerService implements OnModuleInit {
  private readonly logger = new Logger(CategorizerService.name);
  private grpcClient: CategorizerGrpcClient;

  constructor(@Inject('CATEGORIZER_PACKAGE') private client: ClientGrpc) {}

  onModuleInit() {
    this.grpcClient = this.client.getService<CategorizerGrpcClient>('ExpenseCategorizer');
    this.logger.log('gRPC подключен к ML сервису');
  }

  async predict(text: string, userId: string = 'anonymous'): Promise<Prediction> {
    try {
      const response = await lastValueFrom(this.grpcClient.predict({ text, user_id: userId }));

      return {
        primary: response.primary,
        alternatives: response.alternatives || [],
        needs_confirmation: response.needs_confirmation,
        source: response.source,
      };
    } catch (error: any) {
      this.logger.error(`Ошибка предсказания: ${error.message}`);
      throw new Error('ML сервис недоступен');
    }
  }

  async forceRetrain(full: boolean = false): Promise<any> {
    try {
      return await lastValueFrom(this.grpcClient.forceRetrain({ full }));
    } catch (error: any) {
      this.logger.warn(`Force retrain failed: ${error.message}`);
      throw error;
    }
  }

  async getStatus(): Promise<any> {
    return lastValueFrom(this.grpcClient.getStatus({}));
  }
}
