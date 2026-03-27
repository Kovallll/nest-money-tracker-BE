import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '@/auth/jwt-auth.guard';
import { ReceiptOcrService } from './receipt-ocr.service';

const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/octet-stream',
]);

@Controller('receipts')
@UseGuards(JwtAuthGuard)
export class ReceiptOcrController {
  constructor(private readonly receiptOcr: ReceiptOcrService) {}

  /**
   * Загрузка фото чека: PaddleOCR → текст + черновик в transaction_drafts (source=ocr).
   */
  @Post('ocr')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES },
    }),
  )
  async parseReceipt(@UploadedFile() file: any, @Req() req: { user: { id: string } }) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Файл не передан (поле file)');
    }

    const mime = (file.mimetype || '').toLowerCase();
    if (mime && !ALLOWED_MIME.has(mime)) {
      throw new BadRequestException(`Недопустимый тип файла: ${file.mimetype}`);
    }

    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('Не удалось определить пользователя');
    }

    return this.receiptOcr.parseReceiptToDraft({
      userId,
      buffer: file.buffer,
      originalname: file.originalname || 'receipt.jpg',
      mimetype: file.mimetype || 'application/octet-stream',
    });
  }
}
