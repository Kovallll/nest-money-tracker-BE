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

type GroqResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

@Injectable()
export class GroqProvider implements AiProvider {
  private readonly logger = new Logger(GroqProvider.name);

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
    const key = process.env.GROQ_API_KEY?.trim();
    if (!key) {
      throw new ServiceUnavailableException('GROQ_API_KEY не задан');
    }
    return key;
  }

  private model(): string {
    return (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
  }

  private async callGroq(prompt: string): Promise<Record<string, any>> {
    const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
    const body = {
      model: this.model(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    };

    const res = await firstValueFrom(
      this.http.post<GroqResponse>(endpoint, body, {
        headers: {
          Authorization: `Bearer ${this.apiKey()}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
        validateStatus: () => true,
      }),
    );

    if (res.status >= 400) {
      const bodyText = JSON.stringify(res.data ?? {});
      this.logger.warn(`Groq HTTP ${res.status}: ${bodyText}`);

      const messageFromBody =
        (res.data as any)?.error?.message || (res.data as any)?.message || `Groq error: HTTP ${res.status}`;
      throw new ServiceUnavailableException(String(messageFromBody));
    }

    const text = res.data?.choices?.[0]?.message?.content || '{}';
    try {
      return JSON.parse(text);
    } catch {
      throw new BadRequestException('Groq вернул невалидный JSON');
    }
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
      throw new BadRequestException('Groq не вернул корректную сумму');
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
      'Если type="transfer": обязательны cardId (списание) и transferToCardId (зачисление) — две разные карты из списка; categoryId можно опустить или пустая строка.',
      'affectsCardBalance: false только если пользователь явно просит не списывать с карты / без изменения баланса карты; иначе true или опусти поле.',
      'Если валюта в тексте явно не указана, ставь currencyCode="BYN".',
      `sourceType=${input.sourceType}`,
      'Текст:',
      input.sourceText.slice(0, 12000),
      'Карты пользователя:',
      JSON.stringify(cards),
      'Категории пользователя:',
      JSON.stringify(categories),
    ].join('\n');
    const parsed = await this.callGroq(prompt);
    return this.normalizeParsed(parsed, {
      context: input.context,
      sourceTextForCurrency: input.sourceText,
    });
  }

  async parseStatementLines(input: ParseStatementInput): Promise<ParsedTransactionDraft[]> {
    const categories = input.context.categories;
    const cards = input.context.cards;
    const prompt = [
      'Ты разбираешь текст банковской выписки или списка операций.',
      'Верни ТОЛЬКО JSON без markdown в формате:',
      '{"items":[{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue|transfer","paymentMethod":"cash|card","cardId":number,"categoryId":string,"transferToCardId":number,"affectsCardBalance":boolean}]}',
      'Правила:',
      '- В items только отдельные операции (покупки, переводы, зачисления). Без строк «итого», «остаток», «баланс», заголовков таблицы.',
      '- Если в строке только дата без суммы — не включай.',
      '- Не больше 40 позиций; если больше — возьми самые значимые по сумме.',
      '- Для каждой позиции: title — кратко контрагент/назначение; amount всегда положительное число; type expense для списаний, revenue для поступлений.',
      '- transfer только если явно перевод между счетами; тогда cardId и transferToCardId из списка карт.',
      '- cardId и categoryId только из переданных списков; categoryId подбирай по смыслу.',
      '- Если валюта не указана в фрагменте строки, currencyCode="BYN".',
      'Текст выписки:',
      input.sourceText.slice(0, 14000),
      'Карты пользователя:',
      JSON.stringify(cards),
      'Категории пользователя:',
      JSON.stringify(categories),
    ].join('\n');
    const parsed = await this.callGroq(prompt);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const out: ParsedTransactionDraft[] = [];
    for (const row of items) {
      if (!row || typeof row !== 'object') continue;
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
    return out.slice(0, 40);
  }

  async applyEdit(input: EditDraftInput): Promise<ParsedTransactionDraft> {
    const prompt = [
      'Ты редактируешь готовый черновик транзакции по комментарию пользователя.',
      'Верни только JSON без markdown в формате:',
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue|transfer","paymentMethod":"cash|card","cardId":number,"categoryId":string,"transferToCardId":number} плюс опционально affectsCardBalance:boolean',
      'Меняй только то, что пользователь попросил. Остальное оставляй из текущего черновика.',
      'affectsCardBalance: false если просят не списывать с карты; иначе сохраняй из черновика (поле affectsCardBalance).',
      'cardId выбирай только из списка карт, categoryId только из списка категорий.',
      'Текущий черновик:',
      JSON.stringify(input.currentTx),
      'Комментарий пользователя для редактирования:',
      input.editText.slice(0, 4000),
      'Карты пользователя:',
      JSON.stringify(input.context.cards),
      'Категории пользователя:',
      JSON.stringify(input.context.categories),
    ].join('\n');
    const parsed = await this.callGroq(prompt);
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
    const parsed = await this.callGroq(prompt);
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
    const parsed = await this.callGroq(prompt);
    const title = String(parsed.title || '').trim();
    const body = String(parsed.body || '').trim();
    if (!title || !body) {
      throw new BadRequestException('Groq не вернул title/body для daily summary');
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
    const parsed = await this.callGroq(prompt);
    const answer = String(parsed.answer || '').trim();
    if (!answer) throw new BadRequestException('Groq не вернул answer для finance question');
    return {
      answer,
      isFinanceTopic: parsed.isFinanceTopic !== false,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.75))),
      disclaimer: parsed.disclaimer ? String(parsed.disclaimer) : undefined,
    };
  }
}
