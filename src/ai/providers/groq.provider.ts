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
  EditDraftInput,
  ParseReceiptInput,
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

    const validCategoryIds = new Set(categories.map((c) => c.id));
    const selectedCategoryId = validCategoryIds.has(String(parsed.categoryId))
      ? String(parsed.categoryId)
      : input.context.fallbackCategoryId;

    const validCardIds = new Set(cards.map((c) => Number(c.id)));
    const selectedCardId =
      parsed.cardId != null && validCardIds.has(Number(parsed.cardId))
        ? Number(parsed.cardId)
        : (input.fallbackCardId ?? input.context.primaryCardId);

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

    return {
      userId: input.context.userId,
      cardId: selectedCardId,
      categoryId: selectedCategoryId,
      type: parsed.type === 'revenue' ? 'revenue' : 'expense',
      amount,
      title: String(parsed.title || 'Транзакция из Telegram').slice(0, 255),
      description: parsed.description ? String(parsed.description) : undefined,
      date: String(parsed.date || new Date().toISOString().slice(0, 10)),
      currencyCode,
      paymentMethod: parsed.paymentMethod === 'cash' ? 'cash' : 'card',
      affectsCardBalance,
    };
  }

  async parseReceipt(input: ParseReceiptInput): Promise<ParsedTransactionDraft> {
    const categories = input.context.categories;
    const cards = input.context.cards;
    const prompt = [
      'Ты анализируешь чек/сообщение пользователя и возвращаешь только JSON без markdown.',
      'Формат JSON:',
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue","paymentMethod":"cash|card","cardId":number,"categoryId":string} плюс опционально affectsCardBalance:boolean',
      'cardId выбирай только из списка карт пользователя, categoryId только из списка категорий.',
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

  async applyEdit(input: EditDraftInput): Promise<ParsedTransactionDraft> {
    const prompt = [
      'Ты редактируешь готовый черновик транзакции по комментарию пользователя.',
      'Верни только JSON без markdown в формате:',
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue","paymentMethod":"cash|card","cardId":number,"categoryId":string} плюс опционально affectsCardBalance:boolean',
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
      '{"title":string,"description":string,"amount":number,"currencyCode":"BYN|USD|EUR|RUB","date":"YYYY-MM-DD","type":"expense|revenue","paymentMethod":"cash|card","cardId":number,"categoryId":string} плюс опционально affectsCardBalance:boolean',
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
}
