import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  AiProvider,
  DailyActivitySummaryInput,
  DailyActivitySummaryOutput,
  EditDraftInput,
  FinanceQuestionInput,
  FinanceQuestionOutput,
  ParseReceiptInput,
  ParseStatementInput,
  ParsedTransactionDraft,
  RefineReceiptDraftInput,
} from '@/ai/types';

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
};

type GeminiCallOptions = {
  /** Лимит выходных токенов; для больших JSON (выписка) нужен высокий. */
  maxOutputTokens?: number;
  /** false — без JSON mode (надёжнее для больших массивов items). */
  responseJson?: boolean;
};

@Injectable()
export class GeminiProvider implements AiProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  /** Фрагменты выписки: меньше операций за вызов → стабильнее ответ модели. */
  private readonly statementChunkSize = 3800;
  private readonly statementChunkOverlap = 700;

  constructor(private readonly http: HttpService) {}

  private extractExplicitCurrency(text: string): 'BYN' | 'USD' | 'EUR' | 'RUB' | null {
    const src = (text || '').toLowerCase();
    if (
      src.includes('$') ||
      /(^|[^a-z])(usd|dollar|dollars)([^a-z]|$)/i.test(src) ||
      /доллар/.test(src)
    ) {
      return 'USD';
    }
    if (src.includes('€') || /(^|[^a-z])(eur|euro)([^a-z]|$)/i.test(src) || /евро/.test(src)) {
      return 'EUR';
    }
    if (
      src.includes('₽') ||
      /(^|[^a-z])(rub|rur)([^a-z]|$)/i.test(src) ||
      /руб/.test(src)
    ) {
      return 'RUB';
    }
    if (/(^|[^a-z])byn([^a-z]|$)/i.test(src) || /белорус|белар/.test(src)) {
      return 'BYN';
    }
    return null;
  }

  private apiKey(): string {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      throw new ServiceUnavailableException('GEMINI_API_KEY не задан');
    }
    return key;
  }

  private chunkStatementSource(src: string, chunkSize: number, overlap: number): string[] {
    const s = src.slice(0, 100000);
    if (s.length <= chunkSize) return [s];
    const parts: string[] = [];
    let start = 0;
    while (start < s.length) {
      parts.push(s.slice(start, start + chunkSize));
      if (start + chunkSize >= s.length) break;
      start += chunkSize - overlap;
    }
    return parts;
  }

  private statementRowDedupeKey(row: Record<string, any>): string {
    const a = Number(row.amount) || 0;
    const d = String(row.date || '').trim();
    const t = String(row.title || '').trim().toLowerCase().slice(0, 56);
    return `${d}|${a}|${t}`;
  }

  /** Ответ без JSON mode — парсим объект из текста (модель иногда ломает строгий JSON mode на длинных выписках). */
  private extractJsonObjectFromModelText(modelText: string): Record<string, any> {
    let s = String(modelText || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    try {
      return JSON.parse(s) as Record<string, any>;
    } catch {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(s.slice(start, end + 1)) as Record<string, any>;
      }
      throw new BadRequestException('Не удалось выделить JSON из ответа модели');
    }
  }

  private async callGemini(prompt: string, options?: GeminiCallOptions): Promise<Record<string, any>> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey()}`;
    const useJson = options?.responseJson !== false;
    const generationConfig: Record<string, unknown> = {
      temperature: 0.1,
      maxOutputTokens: options?.maxOutputTokens ?? 8192,
    };
    if (useJson) {
      generationConfig.responseMimeType = 'application/json';
    }
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };

    const res = await firstValueFrom(
      this.http.post<GeminiResponse>(endpoint, body, {
        timeout: 180000,
        validateStatus: () => true,
      }),
    );

    const errMsg = res.data?.error?.message;
    if (errMsg) {
      this.logger.warn(`Gemini error payload: ${JSON.stringify(res.data)}`);
      throw new ServiceUnavailableException(String(errMsg));
    }

    if (res.status >= 400) {
      const bodyText = JSON.stringify(res.data ?? {});
      this.logger.warn(`Gemini HTTP ${res.status}: ${bodyText}`);

      const messageFromBody =
        (res.data as any)?.error?.message ||
        (res.data as any)?.message ||
        `Gemini error: HTTP ${res.status}`;
      throw new ServiceUnavailableException(String(messageFromBody));
    }

    const cand = res.data?.candidates?.[0];
    const text = cand?.content?.parts?.[0]?.text;
    if (!text || !String(text).trim()) {
      const block = res.data?.promptFeedback?.blockReason;
      const fr = cand?.finishReason;
      this.logger.warn(
        `Gemini пустой ответ finish=${fr} block=${block} raw=${JSON.stringify(res.data).slice(0, 2500)}`,
      );
      const parts = [
        block ? `Запрос отклонён моделью (${block}).` : '',
        fr ? `Модель не вернула ответ (finish: ${fr}).` : '',
      ].filter(Boolean);
      throw new ServiceUnavailableException(
        parts.length ? parts.join(' ') : 'Gemini вернул пустой ответ. Попробуйте ещё раз.',
      );
    }
    if (useJson) {
      try {
        return JSON.parse(text) as Record<string, any>;
      } catch {
        throw new BadRequestException('Gemini вернул невалидный JSON');
      }
    }
    return this.extractJsonObjectFromModelText(text);
  }

  private normalizeParsed(
    parsed: Record<string, any>,
    input: {
      context: ParseReceiptInput['context'];
      sourceTextForCurrency: string;
      fallbackCardId?: number;
      mergeFrom?: ParsedTransactionDraft;
    },
  ): ParsedTransactionDraft {
    const categories = input.context.categories;
    const cards = input.context.cards || [];

    const amount = Number(parsed.amount);
    if (!amount || Number.isNaN(amount)) {
      throw new BadRequestException('Gemini не вернул корректную сумму');
    }

    const rawType = String(parsed.type ?? input.mergeFrom?.type ?? '').toLowerCase();
    const txType: 'expense' | 'revenue' | 'transfer' =
      rawType === 'revenue' ? 'revenue' : rawType === 'transfer' ? 'transfer' : 'expense';

    const validCategoryIds = new Set(categories.map((c) => c.id));
    const categoryPick =
      parsed.categoryId !== undefined && parsed.categoryId !== null && String(parsed.categoryId) !== ''
        ? String(parsed.categoryId)
        : input.mergeFrom?.categoryId != null && String(input.mergeFrom.categoryId) !== ''
          ? String(input.mergeFrom.categoryId)
          : '';
    const selectedCategoryId =
      txType === 'transfer'
        ? undefined
        : validCategoryIds.has(categoryPick)
          ? categoryPick
          : input.context.fallbackCategoryId;

    const validCardIds = new Set(cards.map((c) => Number(c.id)));
    const fromParsedCard = parsed.cardId != null ? Number(parsed.cardId) : NaN;
    const selectedCardId =
      Number.isFinite(fromParsedCard) && validCardIds.has(fromParsedCard)
        ? fromParsedCard
        : (input.fallbackCardId ?? input.context.primaryCardId);

    let transferToCardId: number | undefined;
    if (txType === 'transfer') {
      const fromParsed = Number(parsed.transferToCardId);
      const fromMerge = Number(input.mergeFrom?.transferToCardId);
      const toId =
        Number.isFinite(fromParsed) && validCardIds.has(fromParsed) ? fromParsed : fromMerge;
      if (!Number.isFinite(toId) || !validCardIds.has(toId) || toId === selectedCardId) {
        throw new BadRequestException(
          'Для перевода укажите transferToCardId — вторую карту из списка, отличную от cardId.',
        );
      }
      transferToCardId = toId;
    }

    const explicitCurrency = this.extractExplicitCurrency(input.sourceTextForCurrency);
    const currencyCode: 'BYN' | 'USD' | 'EUR' | 'RUB' = explicitCurrency
      ? explicitCurrency
      : ['BYN', 'USD', 'EUR', 'RUB'].includes(parsed.currencyCode)
        ? parsed.currencyCode
        : 'BYN';

    const affectsCardBalance =
      typeof parsed.affectsCardBalance === 'boolean'
        ? parsed.affectsCardBalance
        : input.mergeFrom?.affectsCardBalance !== false;

    const base: ParsedTransactionDraft = {
      userId: input.context.userId,
      cardId: selectedCardId,
      type: txType,
      amount,
      title: String(parsed.title || 'Транзакция из Telegram').slice(0, 255),
      description: parsed.description ? String(parsed.description) : undefined,
      date: String(parsed.date || new Date().toISOString().slice(0, 10)),
      currencyCode,
      paymentMethod: parsed.paymentMethod === 'cash' ? 'cash' : 'card',
      affectsCardBalance,
    };
    if (selectedCategoryId !== undefined) base.categoryId = selectedCategoryId;
    if (transferToCardId !== undefined) base.transferToCardId = transferToCardId;
    return base;
  }

  async parseReceipt(input: ParseReceiptInput): Promise<ParsedTransactionDraft> {
    const categories = input.context.categories;
    const cards = input.context.cards;
    const prompt = [
      'Ты анализируешь чек/сообщение пользователя и возвращаешь только JSON без markdown.',
      'Формат JSON:',
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue|transfer","paymentMethod":"cash|card","cardId":number,"categoryId":string,"transferToCardId":number} плюс опционально affectsCardBalance:boolean',
      'cardId выбирай только из списка карт пользователя, categoryId только из списка категорий.',
      'Если type="transfer": обязательны cardId (списание) и transferToCardId (зачисление) — две разные карты из списка; categoryId можно опустить.',
      'affectsCardBalance: false только если пользователь явно просит не списывать с карты; иначе true или опусти поле.',
      'Если валюта в тексте явно не указана, ставь currencyCode="BYN".',
      `sourceType=${input.sourceType}`,
      'Текст:',
      input.sourceText.slice(0, 12000),
      'Карты пользователя:',
      JSON.stringify(cards),
      'Категории пользователя:',
      JSON.stringify(categories),
    ].join('\n');
    const parsed = await this.callGemini(prompt);
    return this.normalizeParsed(parsed, {
      context: input.context,
      sourceTextForCurrency: input.sourceText,
    });
  }

  async parseStatementLines(input: ParseStatementInput): Promise<ParsedTransactionDraft[]> {
    const categories = input.context.categories;
    const cards = input.context.cards;
    const preamble = [
      'Ты разбираешь текст банковской выписки или списка операций.',
      'Ответь ОДНИМ JSON-объектом без пояснений до или после. Без markdown-ограждений.',
      'Формат:',
      '{"items":[{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue|transfer","paymentMethod":"cash|card","cardId":number,"categoryId":string,"transferToCardId":number,"affectsCardBalance":boolean}]}',
      'Правила:',
      '- В items только отдельные операции (покупки, переводы, зачисления). Без строк «итого», «остаток», «баланс», заголовков таблицы.',
      '- Если в строке только дата без суммы — не включай.',
      '- Из текущего ФРАГМЕНТА верни все подходящие операции (не пропускай строки с суммой).',
      '- Для каждой позиции: title — кратко контрагент/назначение; amount всегда положительное число; type expense для списаний, revenue для поступлений.',
      '- transfer только если явно перевод между счетами; тогда cardId и transferToCardId из списка карт.',
      '- cardId и categoryId только из переданных списков; categoryId подбирай по смыслу.',
      '- Если валюта не указана в фрагменте строки, currencyCode="BYN".',
      'Карты пользователя:',
      JSON.stringify(cards),
      'Категории пользователя:',
      JSON.stringify(categories),
    ].join('\n');

    const full = input.sourceText.slice(0, 100000);
    const chunks = this.chunkStatementSource(
      full,
      this.statementChunkSize,
      this.statementChunkOverlap,
    );
    this.logger.log(`parseStatementLines: ${chunks.length} chunk(s), ${full.length} chars`);

    const merged: Record<string, any>[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < chunks.length; i++) {
      const prompt = [
        preamble,
        `Сейчас передан только ФРАГМЕНТ выписки (${i + 1} из ${chunks.length}). Извлеки операции только из этого фрагмента; дубликаты между фрагментами допустимы — их уберём на сервере.`,
        'Фрагмент:',
        chunks[i],
      ].join('\n');

      const parsed = await this.callGemini(prompt, {
        maxOutputTokens: 32768,
        responseJson: false,
      });
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const row of items) {
        if (!row || typeof row !== 'object') continue;
        const k = this.statementRowDedupeKey(row as Record<string, any>);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(row as Record<string, any>);
      }
    }

    const out: ParsedTransactionDraft[] = [];
    for (const row of merged) {
      try {
        out.push(
          this.normalizeParsed(row as Record<string, any>, {
            context: input.context,
            sourceTextForCurrency: JSON.stringify(row),
          }),
        );
      } catch (e) {
        this.logger.warn(`parseStatementLines skip row: ${(e as Error).message}`);
      }
    }
    if (out.length === 0) {
      throw new BadRequestException('Не удалось выделить операции из выписки');
    }
    return out.slice(0, 250);
  }

  async applyEdit(input: EditDraftInput): Promise<ParsedTransactionDraft> {
    const prompt = [
      'Ты редактируешь готовый черновик транзакции по комментарию пользователя.',
      'Верни только JSON без markdown в формате:',
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue|transfer","paymentMethod":"cash|card","cardId":number,"categoryId":string,"transferToCardId":number} плюс опционально affectsCardBalance:boolean',
      'Меняй только то, что пользователь попросил. Остальное оставляй из текущего черновика.',
      'affectsCardBalance: false если просят не списывать с карты; иначе сохраняй из черновика.',
      'cardId выбирай только из списка карт, categoryId только из списка категорий.',
      'Если пользователь явно называет категорию словом (например «транспорт», «продукты»), categoryId должен быть id той категории из списка, чей title совпадает с этим словом или является самым близким по смыслу; не подставляй другую категорию.',
      'Текущий черновик:',
      JSON.stringify(input.currentTx),
      'Комментарий пользователя для редактирования:',
      input.editText.slice(0, 4000),
      'Карты пользователя:',
      JSON.stringify(input.context.cards),
      'Категории пользователя:',
      JSON.stringify(input.context.categories),
    ].join('\n');
    const parsed = await this.callGemini(prompt);
    return this.normalizeParsed(parsed, {
      context: input.context,
      sourceTextForCurrency: input.editText,
      fallbackCardId: input.currentTx.cardId,
      mergeFrom: input.currentTx,
    });
  }

  async refineReceiptDraft(input: RefineReceiptDraftInput): Promise<ParsedTransactionDraft> {
    const prompt = [
      'Ты проверяешь и корректируешь черновик транзакции после OCR чека.',
      'Верни только JSON без markdown в формате:',
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue|transfer","paymentMethod":"cash|card","cardId":number,"categoryId":string,"transferToCardId":number} плюс опционально affectsCardBalance:boolean',
      'Важные правила:',
      '- title и description должны быть короткими (2-6 слов) и осмысленными.',
      '- Для title/description используй НАЗВАНИЕ МАГАЗИНА из шапки чека (например после слова "магазин"), если оно есть.',
      '- Никогда не используй служебные строки как title/description: "итого", "к оплате", "касса", "документ", "чек".',
      '- Если магазин не распознан, оставь title из currentTx и сделай description кратким.',
      '- Сумму, дату, тип, cardId, categoryId, currencyCode не меняй без причины.',
      'Текущий черновик:',
      JSON.stringify(input.currentTx),
      'OCR текст чека:',
      input.sourceText.slice(0, 12000),
      'Карты пользователя:',
      JSON.stringify(input.context.cards),
      'Категории пользователя:',
      JSON.stringify(input.context.categories),
    ].join('\n');
    const parsed = await this.callGemini(prompt);
    return this.normalizeParsed(parsed, {
      context: input.context,
      sourceTextForCurrency: input.sourceText,
      fallbackCardId: input.currentTx.cardId,
      mergeFrom: input.currentTx,
    });
  }

  async generateDailyActivitySummary(
    input: DailyActivitySummaryInput,
  ): Promise<DailyActivitySummaryOutput> {
    const prompt = [
      'Сформируй короткое утреннее push-уведомление на русском языке.',
      'Верни ТОЛЬКО JSON без markdown в формате {"title":string,"body":string}.',
      'Ограничения:',
      '- title до 60 символов',
      '- body до 220 символов',
      '- Тон дружелюбный, краткий, без эмодзи-спама',
      '- Укажи активность за вчера и текущий баланс основной карты',
      '- Если transactionsCount = 0, предложи добавить транзакции сегодня',
      '- Добавь короткое пожелание хорошего дня',
      'Данные пользователя:',
      JSON.stringify(input),
    ].join('\n');
    const parsed = await this.callGemini(prompt);
    const title = String(parsed.title || '').trim();
    const body = String(parsed.body || '').trim();
    if (!title || !body) {
      throw new BadRequestException('Gemini не вернул title/body для daily summary');
    }
    return { title: title.slice(0, 60), body: body.slice(0, 220) };
  }

  async answerFinanceQuestion(input: FinanceQuestionInput): Promise<FinanceQuestionOutput> {
    const prompt = [
      'Ты финансовый AI-ассистент. Отвечай только по финансовым темам: личные финансы, бюджет, долги, налоги, инвестиции, валюты, ставки, инфляция, макроэкономика.',
      'Если вопрос НЕ финансовый, верни краткий отказ и isFinanceTopic=false.',
      'Никогда не выдумывай персональные данные; используй только userContext.',
      'Считай, что userContext содержит полный срез данных пользователя (карты, категории, транзакции, подписки, цели). Используй его максимально полно.',
      'Дай практичный ответ на русском языке, 3-8 предложений.',
      'Для инвестиционных тем добавь дисклеймер в поле disclaimer.',
      'Верни только JSON: {"answer":string,"isFinanceTopic":boolean,"confidence":number,"disclaimer"?:string}',
      'Данные:',
      JSON.stringify(input),
    ].join('\n');
    const parsed = await this.callGemini(prompt);
    const answer = String(parsed.answer || '').trim();
    if (!answer) throw new BadRequestException('Gemini не вернул answer для finance question');
    return {
      answer,
      isFinanceTopic: parsed.isFinanceTopic !== false,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.75))),
      disclaimer: parsed.disclaimer ? String(parsed.disclaimer) : undefined,
    };
  }
}
