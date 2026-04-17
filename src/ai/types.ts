export type AiCategoryOption = {
  id: string;
  title: string;
};

export type AiCardOption = {
  id: number;
  name: string;
  currencyCode: string;
};

export type AiUserContext = {
  userId: string;
  primaryCardId: number;
  cards: AiCardOption[];
  categories: AiCategoryOption[];
  fallbackCategoryId: string;
};

export type ParseReceiptInput = {
  context: AiUserContext;
  sourceText: string;
  sourceType: 'ocr' | 'text';
};

/** Текст выписки / банковского отчёта → несколько операций. */
export type ParseStatementInput = {
  context: AiUserContext;
  sourceText: string;
  /** Смещение по чанкам (0-based) для поэтапного импорта длинной выписки. */
  statementChunkOffset?: number;
  /** Лимит чанков за один вызов (например, 6). */
  statementChunkLimit?: number;
  /** Перед каждым запросом к модели по фрагменту текста (для прогресса в Telegram и т.п.). */
  onStatementChunkProgress?: (p: {
    current: number;
    total: number;
    globalCurrent?: number;
    globalTotal?: number;
  }) => void | Promise<void>;
};

export type ParsedTransactionDraft = {
  userId: string;
  cardId: number;
  /** Для expense/revenue; для transfer можно не задавать. */
  categoryId?: string;
  type: 'expense' | 'revenue' | 'transfer';
  /** Вторая карта при type = transfer (зачисление). */
  transferToCardId?: number;
  amount: number;
  title: string;
  description?: string;
  date: string;
  currencyCode: 'BYN' | 'USD' | 'EUR' | 'RUB';
  paymentMethod: 'cash' | 'card';
  /** false = не менять баланс карты при подтверждении. По умолчанию true. */
  affectsCardBalance?: boolean;
};

export type EditDraftInput = {
  context: AiUserContext;
  currentTx: ParsedTransactionDraft;
  editText: string;
};

/** Произвольная правка всего списка черновика выписки по тексту пользователя (Telegram «править списком»). */
export type ApplyBatchStatementEditInput = {
  context: AiUserContext;
  items: ParsedTransactionDraft[];
  instruction: string;
};

export type RefineReceiptDraftInput = {
  context: AiUserContext;
  currentTx: ParsedTransactionDraft;
  sourceText: string;
};

export type DailyActivitySummaryInput = {
  userId: string;
  userName?: string;
  timezone: string;
  localDate: string;
  yesterdayDate: string;
  transactionsCount: number;
  expensesCount: number;
  expensesTotal: number;
  revenuesCount: number;
  revenuesTotal: number;
  primaryCardName?: string;
  primaryCardCurrency?: string;
  primaryCardBalance?: number;
};

export type DailyActivitySummaryOutput = {
  title: string;
  body: string;
};

export type FinanceQuestionInput = {
  question: string;
  userContext: {
    userId: string;
    monthExpenses: number;
    monthRevenues: number;
    cards?: Array<{
      id: number;
      cardName: string;
      cardBalance: number;
      currencyCode: string;
      isPrimary: boolean;
    }>;
    categories?: Array<{
      id: string;
      name: string;
      monthExpenseTotal: number;
      monthTransactionsCount: number;
    }>;
    recentTransactions?: Array<{
      id: number;
      type: string;
      amount: number;
      currencyCode: string;
      title: string;
      date: string;
      categoryName: string;
    }>;
    goals?: Array<{
      id: string;
      title: string;
      targetBudget: number;
      goalBudget: number;
      currencyCode: string;
      status: string;
    }>;
    subscriptions?: Array<{
      id: string;
      subscribeName: string;
      amount: number;
      currencyCode: string;
      subscribeDate: string;
      isActive: boolean;
    }>;
    topExpenseCategories?: Array<{
      categoryId: string | null;
      category: string;
      total: number;
    }>;
    activeInsights: Array<{
      type: string;
      title: string;
      message: string;
      severity: string;
      confidence: number;
    }>;
    ratesToByn?: Record<string, number>;
  };
};

export type FinanceQuestionOutput = {
  answer: string;
  isFinanceTopic: boolean;
  confidence: number;
  disclaimer?: string;
};

export interface AiProvider {
  parseReceipt(input: ParseReceiptInput): Promise<ParsedTransactionDraft>;
  /** Разбор выписки: только реальные операции со счёта, без заголовков и итогов. */
  parseStatementLines(input: ParseStatementInput): Promise<ParsedTransactionDraft[]>;
  /** Правка массива черновиков по свободной формулировке (например «все WHOOSH — транспорт»). */
  applyBatchStatementEdit(input: ApplyBatchStatementEditInput): Promise<ParsedTransactionDraft[]>;
  applyEdit(input: EditDraftInput): Promise<ParsedTransactionDraft>;
  refineReceiptDraft(input: RefineReceiptDraftInput): Promise<ParsedTransactionDraft>;
  generateDailyActivitySummary(
    input: DailyActivitySummaryInput,
  ): Promise<DailyActivitySummaryOutput>;
  answerFinanceQuestion(input: FinanceQuestionInput): Promise<FinanceQuestionOutput>;
}
