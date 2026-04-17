import {
  BadRequestException,
  HttpException,
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { Telegraf } from 'telegraf';
import { randomBytes } from 'crypto';
import * as mammoth from 'mammoth';
import { ReceiptOcrService } from '@/receipt-ocr/receipt-ocr.service';
import { AiOrchestratorService } from '@/ai/ai-orchestrator.service';
import type { ParsedTransactionDraft } from '@/ai/types';
import { TransactionsService } from '@/models/transactions/transactions.service';
import { CategoriesService } from '@/models/categories/categories.service';
import { AiInsightsService } from '@/ai-insights/ai-insights.service';
import { GroupRoomsService } from '@/group-rooms/group-rooms.service';

type UserContext = {
  userId: string;
  telegramUserId: number;
  primaryCardId?: number;
  cards: Array<{
    id: number;
    name: string;
    isPrimary: boolean;
    currencyCode: string;
    cardType?: string;
    bankName?: string;
    cardNumber?: string;
  }>;
  categories: Array<{ id: string; title: string; icon: string; color: string }>;
};

type TelegramSingleDraftRaw = {
  tx: PendingTx;
  chatId: number;
  sourceType: 'text' | 'ocr';
  awaitingEdit?: boolean;
};

type TelegramBatchDraftRaw = {
  kind: 'batch';
  items: PendingTx[];
  chatId: number;
  sourceType: 'statement';
  importTarget?: StatementImportTarget;
  statementSourceText?: string;
  parsedChunkOffset?: number;
  parsedChunkCount?: number;
  totalChunkCount?: number;
  hasMoreChunks?: boolean;
  /** Включён режим правок текстом (свободная формулировка или номер строки). */
  batchTextEditMode?: boolean;
  /** Сообщение со списком и кнопками — для правки текста без дублирования. */
  previewMessageId?: number;
};

type StatementImportTarget =
  | { scope: 'personal' }
  | { scope: 'room'; roomId: string; roomName?: string };

type RoomChoice = {
  id: string;
  name: string;
};

type PendingTx = {
  userId: string;
  cardId: number;
  categoryId?: string;
  type: 'expense' | 'revenue' | 'transfer';
  /** Карта зачисления при type = transfer. */
  transferToCardId?: number;
  amount: number;
  title: string;
  description?: string;
  date: string;
  currencyCode: 'BYN' | 'USD' | 'EUR' | 'RUB';
  paymentMethod: 'cash' | 'card';
  /** false — не списывать с карты при создании */
  affectsCardBalance?: boolean;
};

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private botUsername: string | null = null;
  /** Режим следующего вложения: чек (одна операция) или выписка (несколько). Один инстанс процесса. */
  private readonly attachmentIntent = new Map<
    number,
    { kind: 'receipt' | 'statement'; until: number; statementTarget?: StatementImportTarget }
  >();
  private readonly statementContextPicker = new Map<
    number,
    { userId: string; rooms: RoomChoice[]; until: number }
  >();
  private readonly intentTtlMs = 30 * 60 * 1000;
  private readonly statementRoomsPageSize = 6;
  private readonly statementChunkPageSize = 6;
  /** Макс. позиций за один проход AI по выписке (совпадает с промптом провайдера). */
  private readonly batchStatementMaxItems = 250;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly receiptOcrService: ReceiptOcrService,
    private readonly aiService: AiOrchestratorService,
    private readonly transactionsService: TransactionsService,
    private readonly categoriesService: CategoriesService,
    private readonly aiInsightsService: AiInsightsService,
    private readonly groupRoomsService: GroupRoomsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your-telegram-bot-token') {
      this.logger.warn('⚠️ TELEGRAM_BOT_TOKEN не задан — бот не запущен');
      return;
    }

    this.bot = new Telegraf(token);

    try {
      const me = await this.bot.telegram.getMe();
      this.botUsername = me.username ?? null;
      this.logger.log(`🤖 Telegram-бот @${this.botUsername} подключён`);
    } catch (err) {
      this.logger.error(
        '❌ Не удалось получить информацию о боте — проверь TELEGRAM_BOT_TOKEN',
        err,
      );
      this.bot = null;
      return;
    }

    this.registerHandlers();

    const pollingEnv = process.env.TELEGRAM_POLLING_ENABLED ?? '';
    const pollingDisabled = ['false', '0', 'no', 'off'].includes(pollingEnv.toLowerCase().trim());
    this.logger.log(
      `🤖 TELEGRAM_POLLING_ENABLED="${pollingEnv}" → polling ${pollingDisabled ? 'отключён' : 'включён'}`,
    );
    if (pollingDisabled) {
      this.logger.log('🤖 Ссылки для привязки работают без получения сообщений от бота.');
      return;
    }

    this.bot
      .launch()
      .catch((err: any) => {
        const is409 =
          err?.response?.error_code === 409 ||
          err?.message?.includes('409') ||
          err?.message?.includes('Conflict');
        if (is409) {
          this.logger.warn(
            '⚠️ Telegram 409: другой инстанс бота уже получает обновления. ' +
              'Запустите бота только в одном процессе или задайте TELEGRAM_POLLING_ENABLED=false на репликах.',
          );
          return;
        }
        this.logger.error('❌ Ошибка запуска Telegram polling', err);
        this.bot = null;
        this.botUsername = null;
      })
      .then(() => {
        this.logger.log('🤖 Telegram polling запущен');
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.bot?.stop('app shutdown');
  }

  private registerHandlers(): void {
    if (!this.bot) return;

    this.bot.start(async (ctx) => {
      const payload = ctx.payload; // часть после /start — "lk_<код>"

      if (!payload?.startsWith('lk_')) {
        await ctx.reply(this.buildHelpText(), {
          reply_markup: this.buildMainMenuKeyboard(),
        });
        return;
      }

      const code = payload.slice(3); // убираем "lk_"
      const telegramUserId = ctx.from.id;

      try {
        const result = await this.redeemCode(code, telegramUserId);

        if (result.success) {
          await ctx.reply('✅ Аккаунт успешно привязан! Теперь вы будете получать уведомления.', {
            reply_markup: this.buildMainMenuKeyboard(),
          });
        } else {
          await ctx.reply(`❌ ${result.error}`);
        }
      } catch {
        await ctx.reply('❌ Произошла ошибка при привязке. Попробуйте ещё раз.');
      }
    });

    this.bot.on('photo', async (ctx) => {
      await this.handlePhotoMessage(ctx);
    });

    this.bot.on('document', async (ctx) => {
      await this.handleDocumentMessage(ctx);
    });

    this.bot.on('text', async (ctx) => {
      if (ctx.message.text?.startsWith('/start')) return;
      await this.handleTextMessage(ctx);
    });

    this.bot.on('callback_query', async (ctx) => {
      await this.handleCallback(ctx);
    });

    this.bot.catch((err) => {
      this.logger.error('Telegram bot error', err);
    });
  }

  private setAttachmentIntent(
    telegramUserId: number,
    kind: 'receipt' | 'statement',
    statementTarget?: StatementImportTarget,
  ): void {
    this.attachmentIntent.set(telegramUserId, {
      kind,
      until: Date.now() + this.intentTtlMs,
      statementTarget,
    });
  }

  private takeAttachmentIntent(telegramUserId: number): {
    kind: 'receipt' | 'statement';
    statementTarget?: StatementImportTarget;
  } | null {
    const row = this.attachmentIntent.get(telegramUserId);
    if (!row || row.until < Date.now()) {
      this.attachmentIntent.delete(telegramUserId);
      return null;
    }
    this.attachmentIntent.delete(telegramUserId);
    return { kind: row.kind, statementTarget: row.statementTarget };
  }

  private peekAttachmentIntent(telegramUserId: number): 'receipt' | 'statement' | null {
    const row = this.attachmentIntent.get(telegramUserId);
    if (!row || row.until < Date.now()) {
      this.attachmentIntent.delete(telegramUserId);
      return null;
    }
    return row.kind;
  }

  private async getUserRoomChoices(userId: string): Promise<RoomChoice[]> {
    const rows = await this.groupRoomsService.getMyRooms(userId);
    return (rows || []).map((r: any) => ({ id: String(r.id), name: String(r.name || 'Комната') }));
  }

  private buildStatementContextKeyboard(rooms: RoomChoice[], page: number): {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const totalPages = Math.max(1, Math.ceil(rooms.length / this.statementRoomsPageSize));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);
    const start = safePage * this.statementRoomsPageSize;
    const slice = rooms.slice(start, start + this.statementRoomsPageSize);
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [
      [{ text: '🏠 Личное', callback_data: 'stsel:personal' }],
      ...slice.map((r) => [{ text: `👥 ${r.name}`, callback_data: `stsel:room|${r.id}` }]),
    ];
    if (totalPages > 1) {
      inline_keyboard.push([
        { text: '⬅️', callback_data: `stpg:${Math.max(0, safePage - 1)}` },
        { text: `${safePage + 1}/${totalPages}`, callback_data: 'stnoop:1' },
        { text: '➡️', callback_data: `stpg:${Math.min(totalPages - 1, safePage + 1)}` },
      ]);
    }
    inline_keyboard.push([{ text: '❌ Отмена', callback_data: 'stcancel:1' }]);
    return { inline_keyboard };
  }

  private async promptStatementContextSelection(ctx: any, userCtx: UserContext): Promise<void> {
    const rooms = await this.getUserRoomChoices(userCtx.userId);
    this.statementContextPicker.set(userCtx.telegramUserId, {
      userId: userCtx.userId,
      rooms,
      until: Date.now() + this.intentTtlMs,
    });
    await ctx.reply(
      'Куда импортировать выписку?\nВыберите контекст до парсинга (это экономит токены и повышает точность категорий).',
      {
        reply_markup: this.buildStatementContextKeyboard(rooms, 0),
      },
    );
  }

  private async getStatementScopedUserContext(
    baseCtx: UserContext,
    target?: StatementImportTarget,
  ): Promise<UserContext> {
    if (!target || target.scope === 'personal') return baseCtx;
    const roomCategories = await this.categoriesService.getCategoriesByRoomIdForMember(
      target.roomId,
      baseCtx.userId,
    );
    return {
      ...baseCtx,
      categories: roomCategories.map((c) => ({
        id: String(c.id),
        title: String(c.title),
        icon: String(c.icon || 'category'),
        color: String(c.color || '#9CA3AF'),
      })),
    };
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    const fileLink = await this.bot!.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.toString());
    if (!response.ok) {
      throw new ServiceUnavailableException('Не удалось скачать файл из Telegram');
    }
    const arr = await response.arrayBuffer();
    return Buffer.from(arr);
  }

  /**
   * pdf-parse v1: `module.exports = async (buf) => ({ text })`.
   * pdf-parse v2: named export `PDFParse` class, `getText()` / `destroy()`.
   */
  private async extractPdfTextWithPdfParse(buffer: Buffer): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('pdf-parse') as {
      PDFParse?: new (opts: { data: Buffer }) => {
        getText: () => Promise<{ text: string }>;
        destroy: () => Promise<void>;
      };
      default?: unknown;
    };

    if (mod.PDFParse) {
      const parser = new mod.PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return String(result.text || '').trim();
      } finally {
        await parser.destroy();
      }
    }

    const legacyFn = mod as unknown as ((b: Buffer) => Promise<{ text: string }>) | undefined;
    if (typeof legacyFn === 'function') {
      const res = await legacyFn(buffer);
      return String(res.text || '').trim();
    }
    const def = mod.default;
    if (typeof def === 'function') {
      const res = await (def as (b: Buffer) => Promise<{ text: string }>)(buffer);
      return String(res.text || '').trim();
    }

    throw new BadRequestException(
      'Не удалось инициализировать парсер PDF (ожидался pdf-parse v1 или v2). Проверьте зависимости backend.',
    );
  }

  private async extractTextFromDocumentBuffer(params: {
    buffer: Buffer;
    mime?: string;
    fileName: string;
  }): Promise<{ text: string; usedOcr: boolean }> {
    const name = params.fileName.toLowerCase();
    const mime = (params.mime || '').toLowerCase();

    if (mime.includes('pdf') || name.endsWith('.pdf')) {
      try {
        const text = await this.extractPdfTextWithPdfParse(params.buffer);
        return { text, usedOcr: false };
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        const detail = (e as Error)?.message ?? String(e);
        this.logger.warn(`pdf-parse: ${detail}`);
        throw new BadRequestException(
          'Не удалось извлечь текст из PDF. Часто так бывает, если файл с паролем, битый экспорт или внутри только «картинка» страниц без текстового слоя (как скан). Попробуйте: снять пароль, сохранить выписку как PDF из браузера заново, прислать DOCX или фото/скан списка операций.',
        );
      }
    }

    if (
      mime.includes('wordprocessingml') ||
      mime.includes('msword') ||
      name.endsWith('.docx') ||
      name.endsWith('.doc')
    ) {
      if (name.endsWith('.doc') && !name.endsWith('.docx')) {
        throw new BadRequestException(
          'Формат .doc не поддерживается. Сохраните выписку как .docx или PDF.',
        );
      }
      try {
        const result = await mammoth.extractRawText({ buffer: params.buffer });
        return { text: String(result.value || '').trim(), usedOcr: false };
      } catch (e) {
        const detail = (e as Error)?.message ?? String(e);
        this.logger.warn(`mammoth docx: ${detail}`);
        throw new BadRequestException(
          'Не удалось прочитать DOCX. Файл может быть повреждён или иметь нестандартную структуру. Сохраните копию из банка или пришлите PDF.',
        );
      }
    }

    if (mime.startsWith('image/')) {
      const ocr = await this.receiptOcrService.runOcrOnBuffer({
        buffer: params.buffer,
        originalname: params.fileName,
        mimetype: mime || 'application/octet-stream',
      });
      return { text: (ocr.full_text || '').trim(), usedOcr: true };
    }

    throw new BadRequestException(
      'Неподдерживаемый тип файла. Пришлите PDF, DOCX или изображение (JPEG/PNG).',
    );
  }

  private async handlePhotoMessage(ctx: any): Promise<void> {
    try {
      const telegramUserId = Number(ctx.from?.id);
      const chatId = Number(ctx.chat?.id);
      const userCtx = await this.getUserContextByTelegramId(telegramUserId);
      this.ensureUserContext(userCtx);
      const intent = this.takeAttachmentIntent(telegramUserId);
      const asStatement = intent?.kind === 'statement';

      await ctx.reply(
        asStatement
          ? 'Фото получено, распознаю выписку. Это может занять до пары минут...'
          : 'Фото получено, обрабатываю чек. Это может занять до пары минут...',
      );

      const photos = ctx.message?.photo ?? [];
      const best = photos.length ? photos[photos.length - 1] : null;
      if (!best?.file_id) {
        await ctx.reply('Не удалось получить фото. Пришлите изображение повторно.');
        return;
      }

      const buffer = await this.downloadTelegramFile(best.file_id);
      await ctx.reply('Прогресс: 30% — фото загружено, распознаю текст…');
      const ocr = await this.receiptOcrService.runOcrOnBuffer({
        buffer,
        originalname: `telegram_${best.file_id}.jpg`,
        mimetype: 'image/jpeg',
      });

      const sourceText = (ocr.full_text || '').trim();
      if (!sourceText) {
        await ctx.reply('Не удалось распознать текст на фото. Попробуйте более четкий снимок.');
        return;
      }

      if (asStatement) {
        await ctx.reply('Прогресс: 55% — текст распознан, начинаю AI-разбор…');
        const scoped = await this.getStatementScopedUserContext(userCtx, intent?.statementTarget);
        await this.runStatementBatchPreviewWithProgress(
          ctx,
          chatId,
          scoped,
          sourceText,
          intent?.statementTarget,
        );
      } else {
        await this.buildPreviewAndSend(chatId, userCtx, sourceText, 'ocr');
      }
    } catch (error) {
      await this.replyPipelineError(ctx, error);
    }
  }

  private async handleDocumentMessage(ctx: any): Promise<void> {
    try {
      const telegramUserId = Number(ctx.from?.id);
      const chatId = Number(ctx.chat?.id);
      const userCtx = await this.getUserContextByTelegramId(telegramUserId);
      this.ensureUserContext(userCtx);

      const doc = ctx.message?.document;
      if (!doc?.file_id) {
        await ctx.reply('Не удалось получить файл.');
        return;
      }

      const intent = this.takeAttachmentIntent(telegramUserId);
      const fileName = String(doc.file_name || 'upload.bin');
      const mime = String(doc.mime_type || '');

      let asStatement: boolean;
      if (intent?.kind === 'statement') {
        asStatement = true;
      } else if (intent?.kind === 'receipt') {
        asStatement = false;
      } else {
        asStatement =
          mime.includes('pdf') ||
          fileName.toLowerCase().endsWith('.pdf') ||
          mime.includes('wordprocessingml') ||
          fileName.toLowerCase().endsWith('.docx');
      }

      const progressMsg = await ctx.reply('Прогресс: 10% — файл получен, скачиваю…');

      const buffer = await this.downloadTelegramFile(doc.file_id);
      try {
        await ctx.telegram.editMessageText(
          chatId,
          progressMsg.message_id,
          undefined,
          'Прогресс: 30% — файл скачан, извлекаю текст…',
        );
      } catch {
        /* ignore */
      }
      const { text: sourceText } = await this.extractTextFromDocumentBuffer({
        buffer,
        mime,
        fileName,
      });

      if (!sourceText) {
        await ctx.reply('В файле не найден текст для разбора. Попробуйте другой файл или фото.');
        return;
      }

      if (asStatement) {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            progressMsg.message_id,
            undefined,
            'Прогресс: 55% — текст извлечён, начинаю AI-разбор…',
          );
        } catch {
          /* ignore */
        }
        const scoped = await this.getStatementScopedUserContext(userCtx, intent?.statementTarget);
        await this.runStatementBatchPreviewWithProgress(
          ctx,
          chatId,
          scoped,
          sourceText,
          intent?.statementTarget,
        );
      } else {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            progressMsg.message_id,
            undefined,
            'Прогресс: 70% — формирую транзакцию…',
          );
        } catch {
          /* ignore */
        }
        await this.buildPreviewAndSend(
          chatId,
          userCtx,
          sourceText,
          mime.startsWith('image/') ? 'ocr' : 'text',
        );
      }
    } catch (error) {
      await this.replyPipelineError(ctx, error);
    }
  }

  private async handleTextMessage(ctx: any): Promise<void> {
    try {
      const telegramUserId = Number(ctx.from?.id);
      const chatId = Number(ctx.chat?.id);
      const userCtx = await this.getUserContextByTelegramId(telegramUserId);
      this.ensureUserContext(userCtx);

      const sourceText = String(ctx.message?.text || '').trim();
      if (!sourceText) {
        await ctx.reply('Отправьте текст, фото чека или файл выписки (PDF / DOCX).');
        return;
      }
      const lower = sourceText.toLowerCase();
      const isCommand = lower.startsWith('/');
      const normalizedText =
        lower === '➕ добавить транзакцию'
          ? '/add'
          : lower === '🤖 спросить у ai'
            ? '/ask'
            : lower === '📊 инсайты'
              ? '/insights'
              : lower === '⚠️ риски'
                ? '/risk'
                : lower === 'ℹ️ помощь'
                  ? '/help'
                  : lower === '📷 чек (фото/файл)' || lower === '📷 чек (фото или файл)'
                    ? '/receipt_attach'
                    : lower === '📄 выписка (pdf/docx)' || lower === '📄 выписка (pdf/docx/фото)'
                      ? '/statement_attach'
                      : sourceText;

      if (normalizedText === '/готово' || normalizedText === '/done') {
        const cleared = await this.clearBatchTextEditModeIfAny(userCtx.userId);
        if (cleared) {
          await ctx.reply(
            'Режим правок выключен. При необходимости снова нажмите «✏️ Править списком» под списком, затем подтвердите импорт.',
          );
          return;
        }
      }

      const batchTextDraft = await this.getPendingBatchTextEditDraft(userCtx.userId);
      const skipBatchTextCapture =
        isCommand && normalizedText !== '/готово' && normalizedText !== '/done';
      if (batchTextDraft?.raw.batchTextEditMode && !skipBatchTextCapture) {
        const instr = this.parseBatchUserInstruction(sourceText);
        const scopedCtx = await this.getStatementScopedUserContext(
          userCtx,
          batchTextDraft.raw.importTarget,
        );
        const n = batchTextDraft.raw.items.length;
        if (instr.type === 'none') {
          const categoriesForPrompt = scopedCtx.categories.map((c) => ({ id: c.id, title: c.title }));
          const cardsForPrompt = scopedCtx.cards.map((c) => ({
            id: c.id,
            name: c.name,
            currencyCode: c.currencyCode,
          }));
          const fallbackCategoryId =
            categoriesForPrompt[0]?.id ?? batchTextDraft.raw.items[0]?.categoryId ?? '';
          const aiItems = await this.aiService.applyBatchStatementEdit({
            instruction: sourceText,
            items: batchTextDraft.raw.items as ParsedTransactionDraft[],
            context: {
              userId: scopedCtx.userId,
              primaryCardId: scopedCtx.primaryCardId!,
              cards: cardsForPrompt,
              categories: categoriesForPrompt,
              fallbackCategoryId,
            },
          });
          const nextItems = aiItems.map((x) => ({ ...x, userId: userCtx.userId })) as PendingTx[];
          await this.persistBatchItemsUpdate(
            scopedCtx,
            batchTextDraft.draftId,
            batchTextDraft.raw,
            nextItems,
          );
          await this.refreshBatchPreviewOrSend(
            chatId,
            batchTextDraft.draftId,
            batchTextDraft.raw,
            scopedCtx,
            nextItems,
          );
          await ctx.reply('Применил правки ко всему списку.');
          return;
        }
        if (instr.type === 'delete') {
          const line0 = instr.line1 - 1;
          if (line0 < 0 || line0 >= n) {
            await ctx.reply(`Нет строки ${instr.line1}. В списке позиций: 1–${n}.`);
            return;
          }
          const nextItems = batchTextDraft.raw.items.filter((_, i) => i !== line0);
          if (nextItems.length === 0) {
            await this.pool.query(
              `UPDATE transaction_drafts SET status = 'rejected' WHERE id = $1 AND user_id = $2`,
              [batchTextDraft.draftId, userCtx.userId],
            );
            await ctx.reply('Все позиции удалены — черновик импорта отменён.');
            return;
          }
          await this.persistBatchItemsUpdate(
            scopedCtx,
            batchTextDraft.draftId,
            batchTextDraft.raw,
            nextItems,
          );
          await this.refreshBatchPreviewOrSend(
            chatId,
            batchTextDraft.draftId,
            batchTextDraft.raw,
            scopedCtx,
            nextItems,
          );
          await ctx.reply(`Строка ${instr.line1} удалена. Осталось позиций: ${nextItems.length}.`);
          return;
        }
        const line0 = instr.line1 - 1;
        if (line0 < 0 || line0 >= n) {
          await ctx.reply(`Нет строки ${instr.line1}. В списке позиций: 1–${n}.`);
          return;
        }
        const categoriesForPrompt = scopedCtx.categories.map((c) => ({ id: c.id, title: c.title }));
        const fallbackCategoryId =
          categoriesForPrompt[0]?.id ?? batchTextDraft.raw.items[line0].categoryId ?? '';
        const cardsForPrompt = scopedCtx.cards.map((c) => ({
          id: c.id,
          name: c.name,
          currencyCode: c.currencyCode,
        }));
        const currentTx = batchTextDraft.raw.items[line0];
        let updated = await this.aiService.applyEdit({
          editText: instr.instruction,
          currentTx,
          context: {
            userId: scopedCtx.userId,
            primaryCardId: scopedCtx.primaryCardId!,
            cards: cardsForPrompt,
            categories: categoriesForPrompt,
            fallbackCategoryId,
          },
        });
        updated = { ...updated, userId: userCtx.userId };
        if (updated.type !== 'transfer') {
          const forcedCat = this.resolveCategoryIdFromInstruction(
            instr.instruction,
            scopedCtx.categories.map((c) => ({ id: c.id, title: c.title })),
          );
          if (forcedCat) {
            updated = { ...updated, categoryId: forcedCat };
          }
        }
        const nextItems = [...batchTextDraft.raw.items];
        nextItems[line0] = updated as PendingTx;
        await this.persistBatchItemsUpdate(
          scopedCtx,
          batchTextDraft.draftId,
          batchTextDraft.raw,
          nextItems,
        );
        await this.refreshBatchPreviewOrSend(
          chatId,
          batchTextDraft.draftId,
          batchTextDraft.raw,
          scopedCtx,
          nextItems,
        );
        await ctx.reply(`Позиция ${instr.line1} обновлена.`);
        return;
      }

      const pendingBatchHint = await this.getLatestPendingBatchDraft(userCtx.userId);
      if (pendingBatchHint && !isCommand) {
        await ctx.reply(
          'Сначала нажмите кнопку «✏️ Править списком» под черновиком выписки, затем отправьте сообщение с нужной правкой (в свободной форме или с номером строки).',
        );
        return;
      }

      if (normalizedText === '/help' || normalizedText === '/start') {
        await ctx.reply(this.buildHelpText(), {
          reply_markup: this.buildMainMenuKeyboard(),
        });
        return;
      }
      if (normalizedText === '/insights') {
        const insights = await this.aiInsightsService.getInsights(userCtx.userId, {
          status: 'active',
        });
        if (!insights.length) {
          await ctx.reply(
            'Активных AI-инсайтов пока нет. Добавьте больше транзакций или выполните /recompute.',
          );
          return;
        }
        const text = [
          'Ваши AI-инсайты:',
          ...insights.slice(0, 5).map((x, i) => `${i + 1}. ${x.title}\n${x.message}`),
        ].join('\n\n');
        await ctx.reply(text);
        return;
      }
      if (normalizedText === '/risk') {
        const insights = await this.aiInsightsService.getInsights(userCtx.userId, {
          status: 'active',
        });
        const high = insights.filter((x) => x.severity === 'high');
        if (!high.length) {
          await ctx.reply('Высокорисковых сигналов сейчас нет.');
          return;
        }
        await ctx.reply(
          ['Сигналы высокого риска:', ...high.slice(0, 3).map((x) => `- ${x.title}`)].join('\n'),
        );
        return;
      }
      if (normalizedText === '/recompute') {
        const result = await this.aiInsightsService.recomputeUserInsights(
          userCtx.userId,
          'telegram_manual',
        );
        await ctx.reply(`Пересчёт выполнен. Обновлено инсайтов: ${result.created}.`);
        return;
      }
      if (normalizedText === '/ask') {
        await ctx.reply(
          'Напишите ваш вопрос о финансах следующим сообщением или используйте /ask <вопрос>.',
        );
        return;
      }
      if (normalizedText.startsWith('/ask ')) {
        const question = normalizedText.replace('/ask', '').trim();
        if (!question) {
          await ctx.reply('Использование: /ask ваш вопрос');
          return;
        }
        const answer = await this.aiInsightsService.ask(userCtx.userId, question, 'telegram');
        await ctx.reply(answer.answer);
        return;
      }

      const editable = await this.getEditableDraft(userCtx.userId);
      if (editable) {
        const categoriesForPrompt = userCtx.categories.map((c) => ({ id: c.id, title: c.title }));
        const fallbackCategoryId = categoriesForPrompt[0]?.id ?? editable.tx.categoryId ?? '';
        const cardsForPrompt = userCtx.cards.map((c) => ({
          id: c.id,
          name: c.name,
          currencyCode: c.currencyCode,
        }));

        const updated = await this.aiService.applyEdit({
          editText: sourceText,
          currentTx: editable.tx,
          context: {
            userId: userCtx.userId,
            primaryCardId: userCtx.primaryCardId!,
            cards: cardsForPrompt,
            categories: categoriesForPrompt,
            fallbackCategoryId,
          },
        });
        await this.updateDraftRawData(userCtx.userId, editable.draftId, {
          tx: updated,
          chatId: chatId,
          sourceType: 'text',
          awaitingEdit: false,
        });
        await ctx.reply('Изменения применены. Проверьте обновленные данные:');
        await this.sendDraftPreview(chatId, userCtx, editable.draftId, updated);
        return;
      }
      if (normalizedText === '/receipt_attach') {
        this.setAttachmentIntent(telegramUserId, 'receipt');
        await ctx.reply(
          'Режим «чек»: пришлите фото чека, картинку файла или PDF с одним чеком — будет одна транзакция с подтверждением.',
        );
        return;
      }
      if (normalizedText === '/statement_attach') {
        await this.promptStatementContextSelection(ctx, userCtx);
        return;
      }
      if (normalizedText === '/add') {
        await ctx.reply(
          'Введите текст транзакции следующим сообщением или сразу используйте /add <описание>. Пример: /add кофе 7 byn',
        );
        return;
      }
      if (normalizedText.startsWith('/add')) {
        const textForDraft = sourceText.replace(/^\/add/i, '').trim();
        if (!textForDraft) {
          await ctx.reply(
            'Использование: /add <описание транзакции>. Пример: /add кофе 7 byn или /add зарплата 2000 byn',
          );
          return;
        }
        await this.buildPreviewAndSend(chatId, userCtx, textForDraft, 'text');
        return;
      }

      if (isCommand) {
        await ctx.reply(
          'Неизвестная команда. Отправьте /help, чтобы увидеть список доступных команд.',
        );
        return;
      }

      // По умолчанию обычный текст = вопрос ассистенту.
      const answer = await this.aiInsightsService.ask(userCtx.userId, sourceText, 'telegram');
      await ctx.reply(answer.answer);
    } catch (error) {
      await this.replyPipelineError(ctx, error);
    }
  }

  private buildHelpText(): string {
    return [
      'Доступные команды:',
      '/help — показать список команд',
      '/ask <вопрос> — задать вопрос AI-ассистенту',
      '/add <текст> — добавить транзакцию из текста',
      '/insights — активные AI-инсайты',
      '/risk — сигналы высокого риска',
      '/recompute — пересчитать инсайты',
      '',
      'Кнопки «Чек» и «Выписка»: сначала нажмите кнопку, затем пришлите фото или файл (PDF, DOCX).',
      'Для «Выписка» бот сначала спросит контекст (личное/комната), затем начнёт AI-разбор.',
      'Без кнопки: фото чека — одна транзакция; PDF/DOCX — разбор выписки на несколько операций.',
      'Импорт выписки: «Править списком» → отправляйте любые правки текстом (например «все WHOOSH в Транспорт») или по номеру строки. /готово — выйти из правок.',
      '',
      'По умолчанию обычный текст без команды считается вопросом ассистенту.',
    ].join('\n');
  }

  private buildMainMenuKeyboard(): {
    keyboard: Array<Array<{ text: string }>>;
    resize_keyboard: boolean;
  } {
    return {
      keyboard: [
        [{ text: '➕ Добавить транзакцию' }, { text: '🤖 Спросить у AI' }],
        [{ text: '📷 Чек (фото/файл)' }, { text: '📄 Выписка (PDF/DOCX)' }],
        [{ text: '📊 Инсайты' }, { text: '⚠️ Риски' }],
        [{ text: 'ℹ️ Помощь' }],
      ],
      resize_keyboard: true,
    };
  }

  private async handleCallback(ctx: any): Promise<void> {
    try {
      const telegramUserId = Number(ctx.from?.id);
      const data = String(ctx.callbackQuery?.data || '');
      const splitIdx = data.indexOf(':');
      if (splitIdx < 0) {
        await ctx.answerCbQuery('Некорректная команда');
        return;
      }
      const action = data.slice(0, splitIdx);
      const rest = data.slice(splitIdx + 1);

      const userCtx = await this.getUserContextByTelegramId(telegramUserId);
      this.ensureUserContext(userCtx);
      const chatId = Number(ctx.chat?.id);

      if (action === 'stnoop') {
        await ctx.answerCbQuery();
        return;
      }

      if (action === 'stcancel') {
        this.statementContextPicker.delete(telegramUserId);
        await ctx.answerCbQuery('Отменено');
        try {
          await ctx.editMessageText('Выбор контекста отменён. Нажмите «📄 Выписка (PDF/DOCX)» снова.');
        } catch {
          /* ignore */
        }
        return;
      }

      if (action === 'stpg' || action === 'stsel') {
        const picker = this.statementContextPicker.get(telegramUserId);
        if (!picker || picker.until < Date.now() || picker.userId !== userCtx.userId) {
          this.statementContextPicker.delete(telegramUserId);
          await ctx.answerCbQuery('Выбор устарел');
          await ctx.reply('Выбор контекста устарел. Нажмите «📄 Выписка (PDF/DOCX)» снова.');
          return;
        }
        if (action === 'stpg') {
          const page = Math.max(0, Number.parseInt(rest || '0', 10) || 0);
          await ctx.answerCbQuery();
          try {
            await ctx.editMessageReplyMarkup(this.buildStatementContextKeyboard(picker.rooms, page));
          } catch {
            /* ignore */
          }
          return;
        }
        if (rest === 'personal') {
          this.setAttachmentIntent(telegramUserId, 'statement', { scope: 'personal' });
          this.statementContextPicker.delete(telegramUserId);
          await ctx.answerCbQuery('Контекст: личное');
          try {
            await ctx.editMessageText(
              'Контекст выбран: 🏠 Личное.\nТеперь пришлите PDF, DOCX или фото/скан выписки.',
            );
          } catch {
            /* ignore */
          }
          return;
        }
        if (rest.startsWith('room|')) {
          const roomId = rest.slice('room|'.length).trim();
          const room = picker.rooms.find((r) => r.id === roomId);
          if (!room) {
            await ctx.answerCbQuery('Комната не найдена');
            return;
          }
          this.setAttachmentIntent(telegramUserId, 'statement', {
            scope: 'room',
            roomId,
            roomName: room.name,
          });
          this.statementContextPicker.delete(telegramUserId);
          await ctx.answerCbQuery('Контекст: комната');
          try {
            await ctx.editMessageText(
              `Контекст выбран: 👥 ${room.name}.\nТеперь пришлите PDF, DOCX или фото/скан выписки.`,
            );
          } catch {
            /* ignore */
          }
          return;
        }
      }

      if (action === 'bcf' || action === 'bca' || action === 'bte' || action === 'bmore') {
        const draftId = rest;

        const batch = await this.getPendingBatchDraft(userCtx.userId, draftId);
        if (!batch) {
          await ctx.answerCbQuery('Запрос устарел');
          await ctx.reply('Черновик не найден. Отправьте файл заново.');
          return;
        }

        if (action === 'bca') {
          await this.pool.query(
            `UPDATE transaction_drafts SET status = 'rejected' WHERE id = $1 AND user_id = $2`,
            [draftId, userCtx.userId],
          );
          await ctx.answerCbQuery('Отменено');
          await ctx.reply('Импорт выписки отменён.');
          try {
            await ctx.editMessageText(
              `${this.formatBatchPreviewBody(userCtx, batch.raw.items, undefined, batch.raw.importTarget, batch.raw)}\n\n❌ Отменено пользователем.`,
            );
          } catch {
            /* ignore */
          }
          return;
        }

        if (action === 'bte') {
          const nextRaw: TelegramBatchDraftRaw = {
            ...batch.raw,
            batchTextEditMode: true,
          };
          await this.pool.query(
            `UPDATE transaction_drafts SET raw_data = $3::jsonb WHERE id = $1 AND user_id = $2`,
            [draftId, userCtx.userId, JSON.stringify(nextRaw)],
          );
          await ctx.answerCbQuery('Режим правок');
          await ctx.reply(
            [
              'Режим правок включён. В каждом сообщении можно написать правку в свободной форме или командой с номером строки.',
              'Примеры:',
              '4 категория Транспорт',
              'все строки с WHOOSH.BIKE категория Транспорт',
              '12 сумма 25.50',
              '7 удалить',
              'Закончить правки: /готово (или сразу «Создать все»).',
            ].join('\n'),
          );
          return;
        }

        if (action === 'bmore') {
          if (!batch.raw.statementSourceText) {
            await ctx.answerCbQuery('Нет исходного текста');
            await ctx.reply('Не найден исходный текст выписки. Отправьте файл заново.');
            return;
          }
          if (!batch.raw.hasMoreChunks) {
            await ctx.answerCbQuery('Это последняя часть');
            return;
          }
          const nextOffset = (batch.raw.parsedChunkOffset ?? 0) + (batch.raw.parsedChunkCount ?? 0);
          const scopedCtx = await this.getStatementScopedUserContext(userCtx, batch.raw.importTarget);
          await ctx.answerCbQuery('Загружаю следующую часть…');
          const progressMsg = await ctx.reply('Прогресс: 55% — продолжаю AI-разбор…');
          await this.buildStatementBatchPreview(
            chatId,
            scopedCtx,
            batch.raw.statementSourceText,
            {
              importTarget: batch.raw.importTarget,
              draftIdToMerge: draftId,
              statementChunkOffset: nextOffset,
              statementChunkLimit: this.statementChunkPageSize,
              onStatementChunkProgress: async ({ current, total }) => {
                const pct = Math.max(
                  55,
                  Math.min(95, 55 + Math.round((current / Math.max(1, total)) * 40)),
                );
                try {
                  await ctx.telegram.editMessageText(
                    chatId,
                    progressMsg.message_id,
                    undefined,
                    `Прогресс: ${pct}% — продолжаю AI-разбор…`,
                  );
                } catch {
                  /* ignore */
                }
              },
            },
          );
          await ctx.reply('Добавил следующую часть выписки в этот же список.');
          return;
        }

        if (action === 'bcf') {
          const { items } = batch.raw;
          const importTarget = batch.raw.importTarget;
          let ok = 0;
          const errors: string[] = [];
          for (const tx of items) {
            try {
              if (importTarget?.scope === 'room') {
                await this.groupRoomsService.createRoomTransaction(importTarget.roomId, userCtx.userId, {
                  paidBy: userCtx.userId,
                  cardId: tx.cardId,
                  ...(tx.type === 'transfer'
                    ? {
                        type: 'transfer' as const,
                        transferToCardId: tx.transferToCardId,
                      }
                    : {
                        categoryId: tx.categoryId ?? undefined,
                        type: tx.type,
                      }),
                  amount: tx.amount,
                  title: tx.title,
                  description: tx.description,
                  date: tx.date,
                  currencyCode: tx.currencyCode,
                  paymentMethod: tx.paymentMethod,
                  affectsCardBalance: tx.affectsCardBalance !== false,
                });
              } else {
                await this.transactionsService.createTransaction({
                  userId: tx.userId,
                  cardId: String(tx.cardId),
                  ...(tx.type === 'transfer'
                    ? {
                        type: 'transfer' as const,
                        transferToCardId: String(tx.transferToCardId),
                      }
                    : {
                        categoryId: tx.categoryId ?? '',
                        type: tx.type,
                      }),
                  amount: tx.amount,
                  title: tx.title,
                  description: tx.description,
                  date: tx.date,
                  currencyCode: tx.currencyCode,
                  paymentMethod: tx.paymentMethod,
                  affectsCardBalance: tx.affectsCardBalance !== false,
                });
              }
              ok += 1;
            } catch (e) {
              errors.push(`${tx.title}: ${(e as Error).message}`);
            }
          }
          if (ok === 0) {
            await ctx.answerCbQuery('Ошибка создания');
            await ctx.reply(
              `Не удалось создать ни одной транзакции.\n${errors.slice(0, 5).join('\n') || 'Неизвестная ошибка'}`,
            );
            return;
          }
          await this.pool.query(
            `UPDATE transaction_drafts SET status = 'confirmed' WHERE id = $1 AND user_id = $2`,
            [draftId, userCtx.userId],
          );
          await ctx.answerCbQuery('Создано');
          const where =
            importTarget?.scope === 'room'
              ? `комната «${importTarget.roomName || importTarget.roomId}»`
              : 'личный учёт';
          let summary = `Создано транзакций: ${ok} из ${items.length}.\nКонтекст: ${where}.`;
          if (errors.length) summary += `\n\nНе создано:\n${errors.slice(0, 8).join('\n')}`;
          await ctx.reply(summary);
          try {
            await ctx.editMessageText(
              `${this.formatBatchPreviewBody(userCtx, batch.raw.items, undefined, batch.raw.importTarget, batch.raw)}\n\n✅ ${summary}`,
            );
          } catch {
            /* ignore */
          }
          return;
        }
      }

      const draftId = rest;
      if (!draftId) {
        await ctx.answerCbQuery('Некорректная команда');
        return;
      }

      const pending = await this.getPendingDraft(userCtx.userId, draftId);
      if (!pending) {
        await ctx.answerCbQuery('Запрос устарел');
        await ctx.reply('Запрос устарел. Отправьте фото или текст заново.');
        return;
      }

      if (action === 'cancel') {
        await this.pool.query(
          `UPDATE transaction_drafts SET status = 'rejected' WHERE id = $1 AND user_id = $2`,
          [draftId, userCtx.userId],
        );
        await ctx.answerCbQuery('Отменено');
        await ctx.reply(
          'Ок, отменено. Можете отправить новое фото или текст для повторной попытки.',
        );
        return;
      }

      if (action === 'edit') {
        await this.updateDraftRawData(userCtx.userId, draftId, {
          tx: pending.tx,
          chatId: pending.chatId,
          sourceType: 'text',
          awaitingEdit: true,
        });
        await ctx.answerCbQuery('Режим редактирования');
        await ctx.reply(
          'Напишите, что исправить. Например: "дата вчера", "сумма 12.5 usd", "категория продукты".',
        );
        return;
      }

      if (action !== 'confirm') {
        await ctx.answerCbQuery('Неизвестное действие');
        return;
      }

      const tx = pending.tx;
      const created = await this.transactionsService.createTransaction({
        userId: tx.userId,
        cardId: String(tx.cardId),
        ...(tx.type === 'transfer'
          ? {
              type: 'transfer' as const,
              transferToCardId: String(tx.transferToCardId),
            }
          : {
              categoryId: tx.categoryId ?? '',
              type: tx.type,
            }),
        amount: tx.amount,
        title: tx.title,
        description: tx.description,
        date: tx.date,
        currencyCode: tx.currencyCode,
        paymentMethod: tx.paymentMethod,
        affectsCardBalance: tx.affectsCardBalance !== false,
      });

      await this.pool.query(
        `UPDATE transaction_drafts SET status = 'confirmed' WHERE id = $1 AND user_id = $2`,
        [draftId, userCtx.userId],
      );

      await ctx.answerCbQuery('Подтверждено');
      const cardLine =
        created.affectsCardBalance !== false ? 'Списание с карты: да' : 'Списание с карты: нет';
      await ctx.reply(
        `Транзакция создана.\nСумма: ${created.amount} ${created.currencyCode}\nТип: ${created.type}\nДата: ${created.date}\n${cardLine}\nПримечание: это личная транзакция (не комната).`,
      );
    } catch (error) {
      await this.replyPipelineError(ctx, error);
    }
  }

  private ensureUserContext(userCtx: UserContext): void {
    if (!userCtx.userId || !userCtx.primaryCardId) {
      throw new BadRequestException(
        'Для операций в Telegram нужна активная основная карта. Проверьте настройки в приложении.',
      );
    }
  }

  private async buildPreviewAndSend(
    chatId: number,
    userCtx: UserContext,
    sourceText: string,
    sourceType: 'ocr' | 'text',
  ): Promise<void> {
    const categoriesForPrompt = userCtx.categories.map((c) => ({ id: c.id, title: c.title }));
    const fallbackCategoryId = categoriesForPrompt[0]?.id || '';
    if (!fallbackCategoryId) {
      throw new BadRequestException('Не найдены категории пользователя.');
    }

    const parsed = await this.aiService.parseReceipt({
      sourceText,
      sourceType,
      context: {
        userId: userCtx.userId,
        primaryCardId: userCtx.primaryCardId!,
        cards: userCtx.cards.map((c) => ({ id: c.id, name: c.name, currencyCode: c.currencyCode })),
        categories: categoriesForPrompt,
        fallbackCategoryId,
      },
    });
    let finalParsed = parsed;
    if (sourceType === 'ocr') {
      try {
        finalParsed = await this.aiService.refineReceiptDraft({
          currentTx: parsed,
          sourceText,
          context: {
            userId: userCtx.userId,
            primaryCardId: userCtx.primaryCardId!,
            cards: userCtx.cards.map((c) => ({
              id: c.id,
              name: c.name,
              currencyCode: c.currencyCode,
            })),
            categories: categoriesForPrompt,
            fallbackCategoryId,
          },
        });
      } catch (e) {
        this.logger.warn(`OCR draft refine skipped: ${(e as Error).message}`);
      }
      finalParsed = this.applyOcrPostProcessing(sourceText, finalParsed);
    }

    const normalizedDate = this.normalizeDateForInput(sourceText, finalParsed.date);
    const categoryTitle =
      finalParsed.type === 'transfer'
        ? 'Перевод'
        : userCtx.categories.find((c) => c.id === finalParsed.categoryId)?.title || 'Без категории';
    const cardName = this.resolveCardDisplayName(userCtx, finalParsed.cardId);
    const toCardName =
      finalParsed.type === 'transfer' && finalParsed.transferToCardId != null
        ? this.resolveCardDisplayName(userCtx, finalParsed.transferToCardId)
        : '';
    const txForConfirm = { ...finalParsed, date: normalizedDate };

    const { rows } = await this.pool.query(
      `INSERT INTO transaction_drafts (
        user_id, source, card_id, category_id, type, amount, currency_code,
        title, description, date, raw_data, status, expires_at
      ) VALUES ($1, 'telegram', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', NOW() + INTERVAL '30 minutes')
      RETURNING id`,
      [
        finalParsed.userId,
        finalParsed.cardId,
        finalParsed.type === 'transfer' ? null : (finalParsed.categoryId ?? null),
        finalParsed.type,
        finalParsed.amount,
        finalParsed.currencyCode,
        finalParsed.title,
        finalParsed.description ?? null,
        normalizedDate,
        JSON.stringify({ tx: txForConfirm, chatId, sourceType }),
      ],
    );
    const draftId = String(rows[0].id);

    const preview = [
      'Проверьте данные перед созданием транзакции:',
      `Сумма: ${finalParsed.amount} ${finalParsed.currencyCode}`,
      `Тип: ${finalParsed.type}`,
      `Дата: ${normalizedDate}`,
      finalParsed.type === 'transfer'
        ? `Перевод: ${cardName} → ${toCardName}`
        : `Категория: ${categoryTitle}`,
      finalParsed.type === 'transfer' ? null : `Карта: ${cardName}`,
      `Списание с карты: ${finalParsed.affectsCardBalance !== false ? 'да' : 'нет'}`,
      `Заголовок: ${finalParsed.title}`,
      finalParsed.description ? `Описание: ${finalParsed.description}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    await this.sendPreviewMessage(chatId, draftId, preview);
  }

  private async sendDraftPreview(
    chatId: number,
    userCtx: UserContext,
    draftId: string,
    tx: PendingTx,
  ): Promise<void> {
    const categoryTitle =
      tx.type === 'transfer'
        ? 'Перевод'
        : userCtx.categories.find((c) => c.id === tx.categoryId)?.title || 'Без категории';
    const cardName = this.resolveCardDisplayName(userCtx, tx.cardId);
    const toCardName =
      tx.type === 'transfer' && tx.transferToCardId != null
        ? this.resolveCardDisplayName(userCtx, tx.transferToCardId)
        : '';
    const preview = [
      'Проверьте данные перед созданием транзакции:',
      `Сумма: ${tx.amount} ${tx.currencyCode}`,
      `Тип: ${tx.type}`,
      `Дата: ${tx.date}`,
      tx.type === 'transfer'
        ? `Перевод: ${cardName} → ${toCardName}`
        : `Категория: ${categoryTitle}`,
      tx.type === 'transfer' ? null : `Карта: ${cardName}`,
      `Списание с карты: ${tx.affectsCardBalance !== false ? 'да' : 'нет'}`,
      `Заголовок: ${tx.title}`,
      tx.description ? `Описание: ${tx.description}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    await this.sendPreviewMessage(chatId, draftId, preview);
  }

  private async sendPreviewMessage(
    chatId: number,
    draftId: string,
    preview: string,
  ): Promise<void> {
    this.logger.log(`Telegram preview [draft=${draftId}]: ${preview.replace(/\n/g, ' | ')}`);
    await this.bot?.telegram.sendMessage(chatId, preview, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Подтвердить', callback_data: `confirm:${draftId}` },
            { text: 'Редактировать', callback_data: `edit:${draftId}` },
            { text: 'Отмена', callback_data: `cancel:${draftId}` },
          ],
        ],
      },
    });
  }

  private sumDraftAmounts(items: PendingTx[]): number {
    const s = items.reduce((acc, t) => acc + Number(t.amount), 0);
    return Math.round(s * 100) / 100;
  }

  /** Распознавание «номер + правка» или «номер удалить» (номер — строка в списке 1-based). */
  private parseBatchUserInstruction(
    raw: string,
  ):
    | { type: 'none' }
    | { type: 'delete'; line1: number }
    | { type: 'edit'; line1: number; instruction: string } {
    const s = String(raw || '').trim();
    const delA = s.match(/^\s*(\d{1,4})\s+удалить\s*$/i);
    const delB = s.match(/^\s*удалить\s+(\d{1,4})\s*$/i);
    if (delA) return { type: 'delete', line1: Number.parseInt(delA[1], 10) };
    if (delB) return { type: 'delete', line1: Number.parseInt(delB[1], 10) };

    const ed1 = s.match(/^\s*(\d{1,4})\s*[.):\-–]\s*(.+)$/s);
    if (ed1) {
      const instruction = ed1[2].trim();
      if (instruction.length >= 2) {
        return { type: 'edit', line1: Number.parseInt(ed1[1], 10), instruction };
      }
    }
    const ed2 = s.match(/^\s*(\d{1,4})\s+(\S.{1,500})$/s);
    if (ed2) {
      const instruction = ed2[2].trim();
      if (instruction.length >= 2) {
        return { type: 'edit', line1: Number.parseInt(ed2[1], 10), instruction };
      }
    }
    return { type: 'none' };
  }

  /**
   Если в тексте правки явно фигурирует название категории из списка пользователя — фиксируем id,
   чтобы модель не подставляла «похожую» категорию (например вместо «Транспорт»).
   */
  private resolveCategoryIdFromInstruction(
    instruction: string,
    categories: Array<{ id: string; title: string }>,
  ): string | null {
    const low = instruction.toLowerCase().normalize('NFC');
    let best: { id: string; score: number } | null = null;
    for (const c of categories) {
      const t = c.title.trim().toLowerCase();
      if (t.length < 2) continue;
      if (low.includes(t)) {
        const score = t.length;
        if (!best || score > best.score) best = { id: c.id, score };
      }
    }
    const m = low.match(/категори[яию]\s*[:\-]?\s*(.+)$/i);
    if (m) {
      const phrase = m[1].trim().replace(/\s+/g, ' ').split(/[,.;]/)[0].trim();
      if (phrase.length >= 2) {
        for (const c of categories) {
          const t = c.title.trim().toLowerCase();
          if (t.includes(phrase) || phrase.includes(t)) {
            const score = Math.max(t.length, phrase.length);
            if (!best || score > best.score) best = { id: c.id, score };
          }
        }
      }
    }
    return best?.id ?? null;
  }

  private async getPendingBatchTextEditDraft(
    userId: string,
  ): Promise<{ draftId: string; raw: TelegramBatchDraftRaw } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, raw_data
       FROM transaction_drafts
       WHERE user_id = $1
         AND source = 'telegram'
         AND status = 'pending'
         AND raw_data->>'kind' = 'batch'
         AND (raw_data->>'batchTextEditMode')::boolean = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;
    return { draftId: String(rows[0].id), raw: rows[0].raw_data as TelegramBatchDraftRaw };
  }

  private async getLatestPendingBatchDraft(
    userId: string,
  ): Promise<{ draftId: string; raw: TelegramBatchDraftRaw } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, raw_data
       FROM transaction_drafts
       WHERE user_id = $1
         AND source = 'telegram'
         AND status = 'pending'
         AND raw_data->>'kind' = 'batch'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;
    return { draftId: String(rows[0].id), raw: rows[0].raw_data as TelegramBatchDraftRaw };
  }

  private async clearBatchTextEditModeIfAny(userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE transaction_drafts
       SET raw_data = raw_data - 'batchTextEditMode'
       WHERE user_id = $1
         AND source = 'telegram'
         AND status = 'pending'
         AND raw_data->>'kind' = 'batch'
         AND (raw_data->>'batchTextEditMode')::boolean = true`,
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async persistBatchItemsUpdate(
    userCtx: UserContext,
    draftId: string,
    prevRaw: TelegramBatchDraftRaw,
    nextItems: PendingTx[],
  ): Promise<void> {
    const nextRaw: TelegramBatchDraftRaw = {
      kind: 'batch',
      items: nextItems,
      chatId: prevRaw.chatId,
      sourceType: 'statement',
      importTarget: prevRaw.importTarget,
      statementSourceText: prevRaw.statementSourceText,
      parsedChunkOffset: prevRaw.parsedChunkOffset,
      parsedChunkCount: prevRaw.parsedChunkCount,
      totalChunkCount: prevRaw.totalChunkCount,
      hasMoreChunks: prevRaw.hasMoreChunks,
      previewMessageId: prevRaw.previewMessageId,
      batchTextEditMode: prevRaw.batchTextEditMode === true,
    };
    await this.pool.query(
      `UPDATE transaction_drafts SET raw_data = $3::jsonb, amount = $4, title = $5 WHERE id = $1 AND user_id = $2`,
      [
        draftId,
        userCtx.userId,
        JSON.stringify(nextRaw),
        this.sumDraftAmounts(nextItems),
        `Выписка: ${nextItems.length} операций`,
      ],
    );
  }

  private async refreshBatchPreviewOrSend(
    chatId: number,
    draftId: string,
    prevRaw: TelegramBatchDraftRaw,
    userCtx: UserContext,
    items: PendingTx[],
  ): Promise<void> {
    const mid = prevRaw.previewMessageId;
    if (typeof mid === 'number') {
      const ok = await this.tryEditBatchPreviewMessage(
        chatId,
        mid,
        draftId,
        userCtx,
        items,
        prevRaw.importTarget,
        prevRaw,
      );
      if (ok) return;
    }
    await this.sendBatchPreviewMessage(chatId, draftId, userCtx, items, prevRaw.importTarget, prevRaw);
  }

  private formatBatchPreviewBody(
    userCtx: UserContext,
    items: PendingTx[],
    maxLines?: number,
    importTarget?: StatementImportTarget,
    raw?: TelegramBatchDraftRaw,
  ): string {
    const lines = items.map((tx, i) => {
      const catTitle =
        tx.type === 'transfer'
          ? 'Перевод'
          : userCtx.categories.find((c) => c.id === tx.categoryId)?.title || '—';
      const title = String(tx.title).slice(0, 44);
      return `${i + 1}. ${title} — ${tx.amount} ${tx.currencyCode} | ${tx.type} | ${tx.date} | ${catTitle}`;
    });
    const contextLine =
      importTarget?.scope === 'room'
        ? `Контекст: 👥 ${importTarget.roomName || 'Комната'}\n`
        : 'Контекст: 🏠 Личное\n';
    const chunkInfo =
      raw?.totalChunkCount && raw.parsedChunkCount
        ? (() => {
            const done = Math.min(
              raw.totalChunkCount,
              (raw.parsedChunkOffset ?? 0) + raw.parsedChunkCount,
            );
            const pct = Math.max(
              0,
              Math.min(100, Math.round((done / Math.max(1, raw.totalChunkCount)) * 100)),
            );
            const tail = raw.hasMoreChunks ? '. Можно нажать «Продолжить».' : '. Выписка обработана полностью.';
            return `Обработано: ${pct}% (${done}/${raw.totalChunkCount})${tail}\n`;
          })()
        : '';
    const head = `Выписка: ${items.length} операций. Проверьте список:\n${contextLine}${chunkInfo}`;
    const cap = maxLines === undefined ? lines.length : maxLines;
    if (lines.length <= cap) return head + lines.join('\n');
    return (
      head +
      lines.slice(0, cap).join('\n') +
      `\n… всего в импорте ${items.length} операций (полный текст во вложении .txt, если оно было отправлено).`
    );
  }

  private buildBatchPreviewFooter(): string {
    return [
      '',
      '────────',
      'Правки: нажмите «✏️ Править списком», затем сообщениями (свободный текст или команда с номером строки):',
      '  пример: все WHOOSH.BIKE → категория Транспорт',
      '  пример: 4 категория Транспорт',
      '  пример: 12 сумма 25.50',
      '  удалить строку: 7 удалить',
      'Закончить правки: /готово',
    ].join('\n');
  }

  private buildBatchInlineKeyboard(
    draftId: string,
    raw?: TelegramBatchDraftRaw,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: '✅ Создать все', callback_data: `bcf:${draftId}` },
        { text: '❌ Отмена', callback_data: `bca:${draftId}` },
      ],
      [{ text: '✏️ Править списком', callback_data: `bte:${draftId}` }],
    ];
    if (raw?.hasMoreChunks) {
      rows.push([{ text: '➡️ Продолжить', callback_data: `bmore:${draftId}` }]);
    }
    return rows;
  }

  private async sendBatchPreviewMessage(
    chatId: number,
    draftId: string,
    userCtx: UserContext,
    items: PendingTx[],
    importTarget?: StatementImportTarget,
    raw?: TelegramBatchDraftRaw,
  ): Promise<void> {
    const listOnly = this.formatBatchPreviewBody(userCtx, items, undefined, importTarget, raw);
    const footer = this.buildBatchPreviewFooter();
    const fullText = `${listOnly}${footer}`;
    if (fullText.length > 3600) {
      await this.bot!.telegram.sendDocument(
        chatId,
        {
          source: Buffer.from(fullText, 'utf8'),
          filename: `vypiska-import-${draftId.slice(0, 8)}.txt`,
        },
        {
          caption: `Полный список: ${items.length} операций (UTF-8). Ниже — краткий вид и кнопки.`,
        },
      );
    }
    const shortList = this.formatBatchPreviewBody(userCtx, items, 45, importTarget, raw);
    const body = `${shortList}${footer}`.slice(0, 4090);
    this.logger.log(`Telegram batch preview [draft=${draftId}]: ${items.length} items`);
    const msg = await this.bot!.telegram.sendMessage(chatId, body, {
      reply_markup: { inline_keyboard: this.buildBatchInlineKeyboard(draftId, raw) },
    });
    await this.pool.query(
      `UPDATE transaction_drafts SET raw_data = raw_data || $2::jsonb WHERE id = $1 AND user_id = $3`,
      [draftId, JSON.stringify({ previewMessageId: msg.message_id }), userCtx.userId],
    );
  }

  private async tryEditBatchPreviewMessage(
    chatId: number,
    previewMessageId: number,
    draftId: string,
    userCtx: UserContext,
    items: PendingTx[],
    importTarget?: StatementImportTarget,
    raw?: TelegramBatchDraftRaw,
  ): Promise<boolean> {
    if (!this.bot) return false;
    const shortList = this.formatBatchPreviewBody(userCtx, items, 45, importTarget, raw);
    const body = `${shortList}${this.buildBatchPreviewFooter()}`.slice(0, 4090);
    try {
      await this.bot.telegram.editMessageText(chatId, previewMessageId, undefined, body, {
        reply_markup: { inline_keyboard: this.buildBatchInlineKeyboard(draftId, raw) },
      });
      return true;
    } catch (e) {
      this.logger.warn(`Telegram edit batch preview: ${(e as Error).message}`);
      return false;
    }
  }

  /** Выписка: один статус в чате, по мере разбора обновляется «фрагмент N из M». */
  private async runStatementBatchPreviewWithProgress(
    ctx: any,
    chatId: number,
    userCtx: UserContext,
    sourceText: string,
    importTarget?: StatementImportTarget,
  ): Promise<void> {
    let progressMsgId: number | undefined;
    const show = async (text: string) => {
      try {
        if (progressMsgId == null) {
          const m = await ctx.reply(text);
          progressMsgId = m.message_id;
        } else {
          await ctx.telegram.editMessageText(chatId, progressMsgId, undefined, text);
        }
      } catch (e) {
        this.logger.warn(`statement progress: ${(e as Error).message}`);
      }
    };
    const contextLabel =
      importTarget?.scope === 'room' ? `👥 ${importTarget.roomName || 'Комната'}` : '🏠 Личное';
    await show(`Прогресс: 55% — разбираю выписку на операции (AI)...\nКонтекст: ${contextLabel}`);
    await this.buildStatementBatchPreview(chatId, userCtx, sourceText, {
      onStatementChunkProgress: async ({ current, total }) => {
        const pct = Math.max(55, Math.min(95, 55 + Math.round((current / Math.max(1, total)) * 40)));
        await show(`Прогресс: ${pct}% — разбираю выписку (шаг ${current}/${total})…`);
      },
      importTarget,
      statementChunkOffset: 0,
      statementChunkLimit: this.statementChunkPageSize,
    });
    if (progressMsgId != null) {
      try {
        await ctx.telegram.editMessageText(
          chatId,
          progressMsgId,
          undefined,
          'Прогресс: 98% — формирую список операций…',
        );
      } catch {
        /* то же текст / rate limit — не критично */
      }
    }
  }

  private async buildStatementBatchPreview(
    chatId: number,
    userCtx: UserContext,
    sourceText: string,
    opts?: {
      onStatementChunkProgress?: (p: { current: number; total: number }) => void | Promise<void>;
      importTarget?: StatementImportTarget;
      draftIdToMerge?: string;
      statementChunkOffset?: number;
      statementChunkLimit?: number;
    },
  ): Promise<void> {
    const categoriesForPrompt = userCtx.categories.map((c) => ({ id: c.id, title: c.title }));
    const fallbackCategoryId = categoriesForPrompt[0]?.id || '';
    if (!fallbackCategoryId) {
      throw new BadRequestException('Не найдены категории пользователя.');
    }

    const parsedChunkOffset = Math.max(0, Math.trunc(opts?.statementChunkOffset ?? 0));
    const parsedChunkLimit = Math.max(
      1,
      Math.trunc(opts?.statementChunkLimit ?? this.statementChunkPageSize),
    );
    let totalChunkCount = parsedChunkOffset + parsedChunkLimit;
    const parsedAll = await this.aiService.parseStatementLines({
      sourceText,
      context: {
        userId: userCtx.userId,
        primaryCardId: userCtx.primaryCardId!,
        cards: userCtx.cards.map((c) => ({ id: c.id, name: c.name, currencyCode: c.currencyCode })),
        categories: categoriesForPrompt,
        fallbackCategoryId,
      },
      statementChunkOffset: parsedChunkOffset,
      statementChunkLimit: parsedChunkLimit,
      onStatementChunkProgress: async (p) => {
        if (typeof p.globalTotal === 'number') totalChunkCount = p.globalTotal;
        await opts?.onStatementChunkProgress?.({ current: p.current, total: p.total });
      },
    });

    const capped = parsedAll.slice(0, this.batchStatementMaxItems);
    const parsedItems: PendingTx[] = capped.map((p) => ({
      ...p,
      userId: userCtx.userId,
      date: this.normalizeDateForInput(sourceText, p.date),
    }));
    const hasMoreChunks = parsedChunkOffset + parsedChunkLimit < totalChunkCount;

    if (opts?.draftIdToMerge) {
      const pending = await this.getPendingBatchDraft(userCtx.userId, opts.draftIdToMerge);
      if (!pending) {
        throw new BadRequestException('Черновик импорта устарел. Отправьте файл заново.');
      }
      const existing = pending.raw.items;
      const seen = new Set(
        existing.map(
          (x) =>
            `${String(x.date || '').trim()}|${Number(x.amount) || 0}|${String(x.title || '')
              .trim()
              .toLowerCase()
              .slice(0, 56)}`,
        ),
      );
      const merged = [...existing];
      for (const tx of parsedItems) {
        const k = `${String(tx.date || '').trim()}|${Number(tx.amount) || 0}|${String(tx.title || '')
          .trim()
          .toLowerCase()
          .slice(0, 56)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(tx);
      }
      const nextRaw: TelegramBatchDraftRaw = {
        ...pending.raw,
        items: merged.slice(0, this.batchStatementMaxItems),
        importTarget: opts.importTarget ?? pending.raw.importTarget,
        statementSourceText: pending.raw.statementSourceText || sourceText,
        parsedChunkOffset,
        parsedChunkCount: parsedChunkLimit,
        totalChunkCount,
        hasMoreChunks,
      };
      await this.pool.query(
        `UPDATE transaction_drafts SET raw_data = $3::jsonb, amount = $4, title = $5 WHERE id = $1 AND user_id = $2`,
        [
          opts.draftIdToMerge,
          userCtx.userId,
          JSON.stringify(nextRaw),
          this.sumDraftAmounts(nextRaw.items),
          `Выписка: ${nextRaw.items.length} операций`,
        ],
      );
      await this.refreshBatchPreviewOrSend(
        chatId,
        opts.draftIdToMerge,
        nextRaw,
        userCtx,
        nextRaw.items,
      );
      return;
    }

    const items = parsedItems;
    const first = items[0];
    if (!first) {
      throw new BadRequestException('Не удалось выделить операции из выписки');
    }

    const draftTitle = `Выписка: ${items.length} операций`;
    const batchRaw: TelegramBatchDraftRaw = {
      kind: 'batch',
      items,
      chatId,
      sourceType: 'statement',
      importTarget: opts?.importTarget,
      statementSourceText: sourceText,
      parsedChunkOffset,
      parsedChunkCount: parsedChunkLimit,
      totalChunkCount,
      hasMoreChunks,
    };

    const { rows } = await this.pool.query(
      `INSERT INTO transaction_drafts (
        user_id, source, card_id, category_id, type, amount, currency_code,
        title, description, date, raw_data, status, expires_at
      ) VALUES ($1, 'telegram', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', NOW() + INTERVAL '45 minutes')
      RETURNING id`,
      [
        userCtx.userId,
        first.cardId,
        first.type === 'transfer' ? null : (first.categoryId ?? null),
        first.type,
        this.sumDraftAmounts(items),
        first.currencyCode,
        draftTitle,
        null,
        first.date,
        JSON.stringify(batchRaw),
      ],
    );
    const draftId = String(rows[0].id);
    await this.sendBatchPreviewMessage(chatId, draftId, userCtx, items, opts?.importTarget, batchRaw);
  }

  private async getPendingBatchDraft(
    userId: string,
    draftId: string,
  ): Promise<{ raw: TelegramBatchDraftRaw } | null> {
    const { rows } = await this.pool.query(
      `SELECT raw_data
       FROM transaction_drafts
       WHERE id = $1
         AND user_id = $2
         AND source = 'telegram'
         AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [draftId, userId],
    );
    if (rows.length === 0) return null;
    const raw = rows[0].raw_data as TelegramBatchDraftRaw;
    if (raw?.kind !== 'batch' || !Array.isArray(raw.items) || raw.items.length === 0) return null;
    return { raw };
  }

  private resolveCardDisplayName(userCtx: UserContext, cardId: number): string {
    const card = userCtx.cards.find((c) => c.id === cardId);
    if (!card) return `Карта #${cardId}`;

    const name = String(card.name || '').trim();
    const cardType = String(card.cardType || '').trim();
    const bankName = String(card.bankName || (card as any).bank_name || '').trim();
    const cardNumber = String(card.cardNumber || (card as any).card_number || '');
    const last4 = cardNumber.replace(/\D/g, '').slice(-4);

    if (bankName && last4.length === 4) {
      return `${bankName} *${last4}`;
    }

    // If card name is just a payment system (e.g. "Visa"), enrich it for clearer preview.
    if (name && cardType && name.toLowerCase() === cardType.toLowerCase() && bankName) {
      return `${bankName} ${name}`;
    }
    return name || `Карта #${cardId}`;
  }

  private async getPendingDraft(
    userId: string,
    draftId: string,
  ): Promise<{ tx: PendingTx; chatId: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT raw_data
       FROM transaction_drafts
       WHERE id = $1
         AND user_id = $2
         AND source = 'telegram'
         AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (raw_data->>'kind' IS NULL OR raw_data->>'kind' <> 'batch')
       LIMIT 1`,
      [draftId, userId],
    );
    if (rows.length === 0) return null;
    const raw = rows[0].raw_data as TelegramSingleDraftRaw;
    if (!raw?.tx || !raw?.chatId) return null;
    return { tx: raw.tx, chatId: Number(raw.chatId) };
  }

  private async getEditableDraft(
    userId: string,
  ): Promise<{ draftId: string; tx: PendingTx; chatId: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, raw_data
       FROM transaction_drafts
       WHERE user_id = $1
         AND source = 'telegram'
         AND status = 'pending'
         AND (raw_data->>'awaitingEdit')::boolean = true
         AND (raw_data->>'kind' IS NULL OR raw_data->>'kind' <> 'batch')
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as { id: string; raw_data: { tx?: PendingTx; chatId?: number } };
    if (!row.raw_data?.tx || !row.raw_data?.chatId) return null;
    return { draftId: row.id, tx: row.raw_data.tx, chatId: Number(row.raw_data.chatId) };
  }

  private async updateDraftRawData(
    userId: string,
    draftId: string,
    rawData: TelegramSingleDraftRaw,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE transaction_drafts
       SET raw_data = $3::jsonb
       WHERE id = $1 AND user_id = $2`,
      [draftId, userId, JSON.stringify(rawData)],
    );
  }

  private async replyPipelineError(ctx: any, error: unknown): Promise<void> {
    const err = error as Error;
    let text: string;
    if (err instanceof ServiceUnavailableException || err instanceof BadRequestException) {
      text = err.message;
    } else if (error instanceof HttpException) {
      const body = (error as HttpException).getResponse();
      text =
        typeof body === 'string'
          ? body
          : typeof body === 'object' && body && 'message' in body
            ? String((body as { message: unknown }).message)
            : (error as HttpException).message;
    } else {
      text = 'Ошибка обработки. Попробуйте снова чуть позже.';
    }

    if (text.includes('Пользователь не привязан к Telegram')) {
      await ctx.reply(
        'Ваш Telegram не привязан к аккаунту. Откройте приложение и выполните привязку.',
      );
      return;
    }

    await ctx.reply(text);
    this.logger.warn(`Telegram pipeline error: ${err.message}`);
  }

  private normalizeDateForInput(sourceText: string, candidateDate: string): string {
    const today = new Date().toISOString().slice(0, 10);
    const looksLikeIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(String(candidateDate || ''));
    const inputHasDateHint =
      /\b\d{4}-\d{2}-\d{2}\b/.test(sourceText) ||
      /\b\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?\b/.test(sourceText);

    if (!inputHasDateHint) return today;
    return looksLikeIsoDate ? candidateDate : today;
  }

  private applyOcrPostProcessing(sourceText: string, parsed: PendingTx): PendingTx {
    const next: PendingTx = { ...parsed };

    const explicitDate = this.extractDateFromText(sourceText);
    next.date = explicitDate || new Date().toISOString().slice(0, 10);

    const total = this.extractReceiptTotal(sourceText);
    if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
      next.amount = total;
    }

    const storeName = this.extractStoreName(sourceText);
    if (storeName) {
      const title = String(next.title || '').trim();
      const description = String(next.description || '').trim();
      const badTitle =
        !title ||
        title.length > 28 ||
        (/^[A-Za-z0-9 .,_-]+$/.test(title) && !/[А-Яа-яЁё]/.test(title));
      const badDescription =
        !description ||
        description.length > 56 ||
        (/^[A-Za-z0-9 .,_-]+$/.test(description) && !/[А-Яа-яЁё]/.test(description));

      if (badTitle) next.title = storeName;
      if (badDescription) next.description = storeName;
    }

    return next;
  }

  private extractReceiptTotal(sourceText: string): number | null {
    const src = String(sourceText || '');
    const hits: number[] = [];
    const totalRegex = /(итог|к\s*оплате|сумма|безналичными)[^\n\r]{0,45}?(\d{1,7}[.,-]\d{2})/gi;
    for (const m of src.matchAll(totalRegex)) {
      const normalized = (m[2] || '').replace(',', '.').replace('-', '.');
      const value = Number.parseFloat(normalized);
      if (Number.isFinite(value) && value > 0) hits.push(value);
    }
    if (!hits.length) return null;
    return hits[hits.length - 1];
  }

  private extractDateFromText(sourceText: string): string | null {
    const src = String(sourceText || '');
    const keywordDateRegex =
      /(дата|чек|документ|время)[^\n\r]{0,30}?(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i;
    const fullDateRegex = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/;
    const raw = keywordDateRegex.exec(src)?.[2] || fullDateRegex.exec(src)?.[1];
    if (!raw) return null;

    const parts = raw.split(/[./-]/).map((p) => Number.parseInt(p, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
    let [day, month, year] = parts;
    if (year < 100) year += 2000;
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;

    const iso = `${year.toString().padStart(4, '0')}-${month
      .toString()
      .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    return iso;
  }

  private extractStoreName(sourceText: string): string | null {
    const lines = String(sourceText || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20);

    for (const line of lines) {
      const cleaned = line
        .replace(/[^A-Za-zА-Яа-яЁё0-9\s"«».-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length < 3) continue;
      if (
        /(итог|касса|чек|документ|инн|сайт|получите|подробности|скидка|цена|кол-во|карта)/i.test(
          cleaned,
        )
      ) {
        continue;
      }
      if (!/[A-Za-zА-Яа-яЁё]{3,}/.test(cleaned)) continue;

      const words = cleaned.split(' ').slice(0, 4).join(' ');
      return words;
    }
    return null;
  }

  async generateLinkCode(userId: string): Promise<{ code: string; link: string }> {
    await this.pool.query(
      `DELETE FROM link_codes WHERE user_id = $1 AND (used_at IS NOT NULL OR expires_at < NOW())`,
      [userId],
    );

    const existing = await this.pool.query(
      `
      SELECT code
      FROM link_codes
      WHERE user_id = $1
        AND used_at IS NULL
        AND expires_at >= NOW()
      ORDER BY expires_at DESC
      LIMIT 1
      `,
      [userId],
    );

    const code =
      existing.rows.length > 0 ? String(existing.rows[0].code) : randomBytes(16).toString('hex');

    if (existing.rows.length === 0) {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 минут
      await this.pool.query(
        `INSERT INTO link_codes (code, user_id, expires_at) VALUES ($1, $2, $3)`,
        [code, userId, expiresAt],
      );
    }

    if (!this.botUsername) {
      throw new ServiceUnavailableException(
        'Telegram-бот не инициализирован. Проверьте TELEGRAM_BOT_TOKEN и перезапустите сервер.',
      );
    }

    const link = `https://t.me/${this.botUsername}?start=lk_${code}`;

    return { code, link };
  }

  async getLinkStatus(userId: string): Promise<{ linked: boolean; telegramUserId?: number }> {
    const { rows } = await this.pool.query(
      'SELECT telegram_user_id FROM user_telegram WHERE user_id = $1',
      [userId],
    );

    if (rows.length === 0) return { linked: false };
    return { linked: true, telegramUserId: Number(rows[0].telegram_user_id) };
  }

  async unlinkTelegram(userId: string): Promise<{ success: boolean }> {
    const result = await this.pool.query('DELETE FROM user_telegram WHERE user_id = $1', [userId]);
    return { success: (result.rowCount ?? 0) > 0 };
  }

  async getUserContextByTelegramId(telegramUserId: number): Promise<UserContext> {
    const { rows } = await this.pool.query(
      `
      SELECT
        ut.user_id::text AS user_id,
        cards_agg.primary_card_id,
        cards_agg.cards
      FROM user_telegram ut
      LEFT JOIN LATERAL (
        SELECT
          (array_agg(c.id ORDER BY c.is_primary DESC, c.created_at ASC))[1] AS primary_card_id,
          COALESCE(
            json_agg(
              json_build_object(
                'id', c.id,
                'name', c.card_name,
                'isPrimary', c.is_primary,
                'currencyCode', c.currency_code,
                'cardType', c.card_type,
                'bankName', c.bank_name,
                'cardNumber', c.card_number,
                'bank_name', c.bank_name,
                'card_number', c.card_number
              )
              ORDER BY c.is_primary DESC, c.created_at ASC
            ) FILTER (WHERE c.id IS NOT NULL),
            '[]'::json
          ) AS cards
        FROM cards c
        WHERE c.user_id = ut.user_id
          AND c.is_active = true
      ) cards_agg ON true
      WHERE ut.telegram_user_id = $1
      ORDER BY ut.linked_at DESC
      LIMIT 1
      `,
      [telegramUserId],
    );

    if (rows.length === 0) {
      throw new ServiceUnavailableException('Пользователь не привязан к Telegram');
    }

    const row = rows[0] as {
      user_id: string;
      primary_card_id: number | null;
      cards: Array<{
        id: number;
        name: string;
        isPrimary: boolean;
        currencyCode: string;
        cardType?: string;
        bankName?: string;
        cardNumber?: string;
      }>;
    };

    const categoryItems = await this.categoriesService.getCategoriesByUserId(row.user_id);

    return {
      userId: row.user_id,
      telegramUserId,
      primaryCardId: row.primary_card_id != null ? Number(row.primary_card_id) : undefined,
      cards: (row.cards ?? []).map((c) => ({
        id: Number(c.id),
        name: String(c.name),
        isPrimary: Boolean(c.isPrimary),
        currencyCode: String(c.currencyCode || 'BYN'),
        cardType: c.cardType ? String(c.cardType) : undefined,
        bankName: c.bankName ? String(c.bankName) : undefined,
        cardNumber: c.cardNumber ? String(c.cardNumber) : undefined,
      })),
      categories: categoryItems.map((c) => ({
        id: String(c.id),
        title: String(c.title),
        icon: String(c.icon || 'category'),
        color: String(c.color || '#9CA3AF'),
      })),
    };
  }

  private async redeemCode(
    code: string,
    telegramUserId: number,
  ): Promise<{ success: boolean; error?: string }> {
    const { rows } = await this.pool.query(
      `SELECT user_id, expires_at, used_at FROM link_codes WHERE code = $1`,
      [code],
    );

    if (rows.length === 0) {
      return { success: false, error: 'Код не найден или недействителен.' };
    }

    const linkCode = rows[0];

    if (linkCode.used_at) {
      const alreadyBoundToSameTelegram = await this.pool.query(
        `SELECT 1 FROM user_telegram WHERE user_id = $1 AND telegram_user_id = $2 LIMIT 1`,
        [linkCode.user_id, telegramUserId],
      );
      if ((alreadyBoundToSameTelegram.rowCount ?? 0) > 0) {
        return { success: true };
      }
      return { success: false, error: 'Этот код уже был использован.' };
    }

    if (new Date(linkCode.expires_at) < new Date()) {
      return { success: false, error: 'Код просрочен. Получите новый в приложении.' };
    }

    await this.pool.query(`UPDATE link_codes SET used_at = NOW() WHERE code = $1`, [code]);

    await this.pool.query(
      `
      INSERT INTO user_telegram (user_id, telegram_user_id, linked_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id)
      DO UPDATE
      SET telegram_user_id = EXCLUDED.telegram_user_id,
          linked_at = NOW()
      `,
      [linkCode.user_id, telegramUserId],
    );

    return { success: true };
  }
}

