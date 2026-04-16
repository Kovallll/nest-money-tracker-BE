import {
  BadRequestException,
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
// pdf-parse поставляется как CommonJS
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
import { ReceiptOcrService } from '@/receipt-ocr/receipt-ocr.service';
import { AiOrchestratorService } from '@/ai/ai-orchestrator.service';
import { TransactionsService } from '@/models/transactions/transactions.service';
import { CategoriesService } from '@/models/categories/categories.service';
import { AiInsightsService } from '@/ai-insights/ai-insights.service';

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
  /** Индекс строки (0-based), если ждём правку текста для этой позиции. */
  batchEditLine?: number;
  /** Сообщение со списком и кнопками — для правки текста без дублирования. */
  previewMessageId?: number;
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
    { kind: 'receipt' | 'statement'; until: number }
  >();
  private readonly intentTtlMs = 30 * 60 * 1000;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly receiptOcrService: ReceiptOcrService,
    private readonly aiService: AiOrchestratorService,
    private readonly transactionsService: TransactionsService,
    private readonly categoriesService: CategoriesService,
    private readonly aiInsightsService: AiInsightsService,
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

  private setAttachmentIntent(telegramUserId: number, kind: 'receipt' | 'statement'): void {
    this.attachmentIntent.set(telegramUserId, {
      kind,
      until: Date.now() + this.intentTtlMs,
    });
  }

  private takeAttachmentIntent(telegramUserId: number): 'receipt' | 'statement' | null {
    const row = this.attachmentIntent.get(telegramUserId);
    if (!row || row.until < Date.now()) {
      this.attachmentIntent.delete(telegramUserId);
      return null;
    }
    this.attachmentIntent.delete(telegramUserId);
    return row.kind;
  }

  private peekAttachmentIntent(telegramUserId: number): 'receipt' | 'statement' | null {
    const row = this.attachmentIntent.get(telegramUserId);
    if (!row || row.until < Date.now()) {
      this.attachmentIntent.delete(telegramUserId);
      return null;
    }
    return row.kind;
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

  private async extractTextFromDocumentBuffer(params: {
    buffer: Buffer;
    mime?: string;
    fileName: string;
  }): Promise<{ text: string; usedOcr: boolean }> {
    const name = params.fileName.toLowerCase();
    const mime = (params.mime || '').toLowerCase();

    if (mime.includes('pdf') || name.endsWith('.pdf')) {
      const res = await pdfParse(params.buffer);
      return { text: String(res.text || '').trim(), usedOcr: false };
    }

    if (
      mime.includes('wordprocessingml') ||
      mime.includes('msword') ||
      name.endsWith('.docx') ||
      name.endsWith('.doc')
    ) {
      if (name.endsWith('.doc') && !name.endsWith('.docx')) {
        throw new BadRequestException('Формат .doc не поддерживается. Сохраните выписку как .docx или PDF.');
      }
      const result = await mammoth.extractRawText({ buffer: params.buffer });
      return { text: String(result.value || '').trim(), usedOcr: false };
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
      const asStatement = intent === 'statement';

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
        await this.buildStatementBatchPreview(chatId, userCtx, sourceText);
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
      if (intent === 'statement') {
        asStatement = true;
      } else if (intent === 'receipt') {
        asStatement = false;
      } else {
        asStatement =
          mime.includes('pdf') ||
          fileName.toLowerCase().endsWith('.pdf') ||
          mime.includes('wordprocessingml') ||
          fileName.toLowerCase().endsWith('.docx');
      }

      await ctx.reply('Файл получен, извлекаю текст...');

      const buffer = await this.downloadTelegramFile(doc.file_id);
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
        await ctx.reply('Разбираю выписку на операции (AI)...');
        await this.buildStatementBatchPreview(chatId, userCtx, sourceText);
      } else {
        await ctx.reply('Формирую одну транзакцию по содержимому...');
        await this.buildPreviewAndSend(chatId, userCtx, sourceText, mime.startsWith('image/') ? 'ocr' : 'text');
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

      const batchLineDraft = await this.getPendingBatchLineEditDraft(userCtx.userId);
      if (batchLineDraft) {
        const lineIndex = batchLineDraft.batchEditLine;
        if (lineIndex < 0 || lineIndex >= batchLineDraft.raw.items.length) {
          const cleared: TelegramBatchDraftRaw = { ...batchLineDraft.raw };
          delete cleared.batchEditLine;
          await this.pool.query(
            `UPDATE transaction_drafts SET raw_data = $3::jsonb WHERE id = $1 AND user_id = $2`,
            [batchLineDraft.draftId, userCtx.userId, JSON.stringify(cleared)],
          );
          await ctx.reply('Редактирование сброшено. Отправьте выписку заново или выберите позицию снова.');
          return;
        }
        const categoriesForPrompt = userCtx.categories.map((c) => ({ id: c.id, title: c.title }));
        const fallbackCategoryId =
          categoriesForPrompt[0]?.id ?? batchLineDraft.raw.items[lineIndex].categoryId ?? '';
        const cardsForPrompt = userCtx.cards.map((c) => ({
          id: c.id,
          name: c.name,
          currencyCode: c.currencyCode,
        }));
        const currentTx = batchLineDraft.raw.items[lineIndex];
        const updated = await this.aiService.applyEdit({
          editText: sourceText,
          currentTx,
          context: {
            userId: userCtx.userId,
            primaryCardId: userCtx.primaryCardId!,
            cards: cardsForPrompt,
            categories: categoriesForPrompt,
            fallbackCategoryId,
          },
        });
        const nextItems = [...batchLineDraft.raw.items];
        nextItems[lineIndex] = { ...updated, userId: userCtx.userId };
        const nextRaw: TelegramBatchDraftRaw = {
          ...batchLineDraft.raw,
          items: nextItems,
        };
        delete nextRaw.batchEditLine;
        await this.pool.query(
          `UPDATE transaction_drafts SET raw_data = $3::jsonb WHERE id = $1 AND user_id = $2`,
          [batchLineDraft.draftId, userCtx.userId, JSON.stringify(nextRaw)],
        );
        const mid = batchLineDraft.raw.previewMessageId;
        const edited =
          typeof mid === 'number' &&
          (await this.tryEditBatchPreviewMessage(
            chatId,
            mid,
            batchLineDraft.draftId,
            userCtx,
            nextItems,
          ));
        if (!edited) {
          await this.sendBatchPreviewMessage(chatId, batchLineDraft.draftId, userCtx, nextItems);
        }
        await ctx.reply('Правки к позиции применены. Список обновлён.');
        return;
      }

      if (normalizedText === '/help' || normalizedText === '/start') {
        await ctx.reply(this.buildHelpText(), {
          reply_markup: this.buildMainMenuKeyboard(),
        });
        return;
      }
      if (normalizedText === '/insights') {
        const insights = await this.aiInsightsService.getInsights(userCtx.userId, { status: 'active' });
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
        const insights = await this.aiInsightsService.getInsights(userCtx.userId, { status: 'active' });
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
        const result = await this.aiInsightsService.recomputeUserInsights(userCtx.userId, 'telegram_manual');
        await ctx.reply(`Пересчёт выполнен. Обновлено инсайтов: ${result.created}.`);
        return;
      }
      if (normalizedText === '/ask') {
        await ctx.reply('Напишите ваш вопрос о финансах следующим сообщением или используйте /ask <вопрос>.');
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
        const fallbackCategoryId =
          categoriesForPrompt[0]?.id ?? editable.tx.categoryId ?? '';
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
        this.setAttachmentIntent(telegramUserId, 'statement');
        await ctx.reply(
          'Режим «выписка»: пришлите PDF, DOCX или фото/скан списка операций — бот разобьёт на несколько транзакций. Перед созданием можно удалить или отредактировать строки.',
        );
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
      'Без кнопки: фото чека — одна транзакция; PDF/DOCX — разбор выписки на несколько операций.',
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

      if (action === 'bcf' || action === 'bca' || action === 'bdm' || action === 'bed') {
        const lastColon = rest.lastIndexOf(':');
        const isTriple = action === 'bdm' || action === 'bed';
        const draftId = isTriple ? rest.slice(0, lastColon) : rest;
        const indexPart = isTriple ? rest.slice(lastColon + 1) : '';
        const lineIndex = isTriple ? Number.parseInt(indexPart, 10) : NaN;

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
              `${this.formatBatchPreviewBody(userCtx, batch.raw.items)}\n\n❌ Отменено пользователем.`,
            );
          } catch {
            /* ignore */
          }
          return;
        }

        if (action === 'bcf') {
          const { items } = batch.raw;
          let ok = 0;
          const errors: string[] = [];
          for (const tx of items) {
            try {
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
          let summary = `Создано транзакций: ${ok} из ${items.length}.`;
          if (errors.length) summary += `\n\nНе создано:\n${errors.slice(0, 8).join('\n')}`;
          await ctx.reply(summary);
          try {
            await ctx.editMessageText(
              `${this.formatBatchPreviewBody(userCtx, batch.raw.items)}\n\n✅ ${summary}`,
            );
          } catch {
            /* ignore */
          }
          return;
        }

        if (action === 'bdm') {
          if (!Number.isFinite(lineIndex) || lineIndex < 0 || lineIndex >= batch.raw.items.length) {
            await ctx.answerCbQuery('Некорректная строка');
            return;
          }
          const nextItems = batch.raw.items.filter((_, i) => i !== lineIndex);
          if (nextItems.length === 0) {
            await this.pool.query(
              `UPDATE transaction_drafts SET status = 'rejected' WHERE id = $1 AND user_id = $2`,
              [draftId, userCtx.userId],
            );
            await ctx.answerCbQuery('Список пуст');
            await ctx.reply('Все позиции удалены — черновик отменён.');
            try {
              await ctx.editMessageText(
                `${this.formatBatchPreviewBody(userCtx, batch.raw.items)}\n\n❌ Черновик отменён (список пуст).`,
              );
            } catch {
              /* ignore */
            }
            return;
          }
          const nextRaw: TelegramBatchDraftRaw = {
            kind: 'batch',
            items: nextItems,
            chatId: batch.raw.chatId,
            sourceType: 'statement',
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
          await ctx.answerCbQuery('Удалено');
          const previewText = this.formatBatchPreviewBody(userCtx, nextItems);
          const kb = this.buildBatchInlineKeyboard(draftId, nextItems.length);
          try {
            await ctx.editMessageText(previewText, { reply_markup: { inline_keyboard: kb } });
          } catch {
            await this.bot?.telegram.sendMessage(batch.raw.chatId, previewText, {
              reply_markup: { inline_keyboard: kb },
            });
          }
          return;
        }

        if (action === 'bed') {
          if (!Number.isFinite(lineIndex) || lineIndex < 0 || lineIndex >= batch.raw.items.length) {
            await ctx.answerCbQuery('Некорректная строка');
            return;
          }
          const nextRaw: TelegramBatchDraftRaw = { ...batch.raw, batchEditLine: lineIndex };
          await this.pool.query(
            `UPDATE transaction_drafts SET raw_data = $3::jsonb WHERE id = $1 AND user_id = $2`,
            [draftId, userCtx.userId, JSON.stringify(nextRaw)],
          );
          await ctx.answerCbQuery('Жду правки');
          await ctx.reply(
            `Редактирование позиции ${lineIndex + 1}. Напишите одним сообщением, что изменить (сумма, дата, категория, название).`,
          );
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
        created.affectsCardBalance !== false
          ? 'Списание с карты: да'
          : 'Списание с карты: нет';
      await ctx.reply(
        `Транзакция создана.\nСумма: ${created.amount} ${created.currencyCode}\nТип: ${created.type}\nДата: ${created.date}\n${cardLine}`,
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
        finalParsed.type === 'transfer' ? null : finalParsed.categoryId ?? null,
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
      finalParsed.type === 'transfer' ? `Перевод: ${cardName} → ${toCardName}` : `Категория: ${categoryTitle}`,
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
      tx.type === 'transfer' ? `Перевод: ${cardName} → ${toCardName}` : `Категория: ${categoryTitle}`,
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

  private formatBatchPreviewBody(userCtx: UserContext, items: PendingTx[], maxLines = 40): string {
    const lines = items.map((tx, i) => {
      const catTitle =
        tx.type === 'transfer'
          ? 'Перевод'
          : userCtx.categories.find((c) => c.id === tx.categoryId)?.title || '—';
      const title = String(tx.title).slice(0, 44);
      return `${i + 1}. ${title} — ${tx.amount} ${tx.currencyCode} | ${tx.type} | ${tx.date} | ${catTitle}`;
    });
    const head = `Выписка: ${items.length} операций. Проверьте список:\n`;
    if (lines.length <= maxLines) return head + lines.join('\n');
    return (
      head +
      lines.slice(0, maxLines).join('\n') +
      `\n… всего в импорте ${items.length} операций (сообщение сокращено; кнопки — для всех позиций).`
    );
  }

  private buildBatchInlineKeyboard(
    draftId: string,
    itemCount: number,
  ): Array<Array<{ text: string; callback_data: string }>> {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: '✅ Создать все', callback_data: `bcf:${draftId}` },
        { text: '❌ Отмена', callback_data: `bca:${draftId}` },
      ],
    ];
    for (let i = 0; i < itemCount; i++) {
      rows.push([
        { text: `✏️ ${i + 1}`, callback_data: `bed:${draftId}:${i}` },
        { text: `🗑 ${i + 1}`, callback_data: `bdm:${draftId}:${i}` },
      ]);
    }
    return rows;
  }

  private async sendBatchPreviewMessage(
    chatId: number,
    draftId: string,
    userCtx: UserContext,
    items: PendingTx[],
  ): Promise<void> {
    const body = this.formatBatchPreviewBody(userCtx, items).slice(0, 4090);
    this.logger.log(`Telegram batch preview [draft=${draftId}]: ${items.length} items`);
    const msg = await this.bot!.telegram.sendMessage(chatId, body, {
      reply_markup: { inline_keyboard: this.buildBatchInlineKeyboard(draftId, items.length) },
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
  ): Promise<boolean> {
    if (!this.bot) return false;
    const body = this.formatBatchPreviewBody(userCtx, items).slice(0, 4090);
    try {
      await this.bot.telegram.editMessageText(chatId, previewMessageId, undefined, body, {
        reply_markup: { inline_keyboard: this.buildBatchInlineKeyboard(draftId, items.length) },
      });
      return true;
    } catch (e) {
      this.logger.warn(`Telegram edit batch preview: ${(e as Error).message}`);
      return false;
    }
  }

  private async buildStatementBatchPreview(
    chatId: number,
    userCtx: UserContext,
    sourceText: string,
  ): Promise<void> {
    const categoriesForPrompt = userCtx.categories.map((c) => ({ id: c.id, title: c.title }));
    const fallbackCategoryId = categoriesForPrompt[0]?.id || '';
    if (!fallbackCategoryId) {
      throw new BadRequestException('Не найдены категории пользователя.');
    }

    const parsedAll = await this.aiService.parseStatementLines({
      sourceText,
      context: {
        userId: userCtx.userId,
        primaryCardId: userCtx.primaryCardId!,
        cards: userCtx.cards.map((c) => ({ id: c.id, name: c.name, currencyCode: c.currencyCode })),
        categories: categoriesForPrompt,
        fallbackCategoryId,
      },
    });

    const parsed = parsedAll.slice(0, 30);
    const truncated = parsedAll.length > parsed.length;

    const items: PendingTx[] = parsed.map((p) => ({
      ...p,
      userId: userCtx.userId,
      date: this.normalizeDateForInput(sourceText, p.date),
    }));

    const first = items[0];
    const draftTitle = truncated
      ? `Выписка: ${items.length} из ${parsedAll.length} операций`
      : `Выписка: ${items.length} операций`;
    const batchRaw: TelegramBatchDraftRaw = {
      kind: 'batch',
      items,
      chatId,
      sourceType: 'statement',
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
        first.type === 'transfer' ? null : first.categoryId ?? null,
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
    await this.sendBatchPreviewMessage(chatId, draftId, userCtx, items);
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

  private async getPendingBatchLineEditDraft(
    userId: string,
  ): Promise<{ draftId: string; raw: TelegramBatchDraftRaw; batchEditLine: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, raw_data
       FROM transaction_drafts
       WHERE user_id = $1
         AND source = 'telegram'
         AND status = 'pending'
         AND raw_data->>'kind' = 'batch'
         AND jsonb_typeof(raw_data->'batchEditLine') = 'number'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const raw = rows[0].raw_data as TelegramBatchDraftRaw;
    const line = raw.batchEditLine;
    if (typeof line !== 'number' || line < 0 || line >= raw.items.length) return null;
    return { draftId: String(rows[0].id), raw, batchEditLine: line };
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
    const text =
      err instanceof ServiceUnavailableException || err instanceof BadRequestException
        ? err.message
        : 'Ошибка обработки. Попробуйте снова чуть позже.';

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

