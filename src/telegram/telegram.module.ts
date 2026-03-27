import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { ReceiptOcrModule } from '@/receipt-ocr/receipt-ocr.module';
import { TransactionsModule } from '@/models/transactions/transactions.module';
import { AiModule } from '@/ai/ai.module';

@Module({
  imports: [ReceiptOcrModule, TransactionsModule, AiModule],
  providers: [TelegramService],
  controllers: [TelegramController],
  exports: [TelegramService],
})
export class TelegramModule {}
