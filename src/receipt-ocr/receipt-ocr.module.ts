import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ReceiptOcrController } from './receipt-ocr.controller';
import { ReceiptOcrService } from './receipt-ocr.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 120_000,
      maxRedirects: 0,
    }),
  ],
  controllers: [ReceiptOcrController],
  providers: [ReceiptOcrService],
  exports: [ReceiptOcrService],
})
export class ReceiptOcrModule {}
