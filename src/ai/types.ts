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

export type ParsedTransactionDraft = {
  userId: string;
  cardId: number;
  categoryId: string;
  type: 'expense' | 'revenue';
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

export interface AiProvider {
  parseReceipt(input: ParseReceiptInput): Promise<ParsedTransactionDraft>;
  applyEdit(input: EditDraftInput): Promise<ParsedTransactionDraft>;
  refineReceiptDraft(input: RefineReceiptDraftInput): Promise<ParsedTransactionDraft>;
  generateDailyActivitySummary(
    input: DailyActivitySummaryInput,
  ): Promise<DailyActivitySummaryOutput>;
}
