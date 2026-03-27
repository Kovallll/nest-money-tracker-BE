import { Inject, Injectable } from '@nestjs/common';
import {
  AiProvider,
  EditDraftInput,
  ParseReceiptInput,
  ParsedTransactionDraft,
  RefineReceiptDraftInput,
} from '@/ai/types';
import { GeminiProvider } from '@/ai/providers/gemini.provider';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

@Injectable()
export class AiOrchestratorService {
  constructor(@Inject(AI_PROVIDER) private readonly provider: AiProvider) {}

  parseReceipt(input: ParseReceiptInput): Promise<ParsedTransactionDraft> {
    return this.provider.parseReceipt(input);
  }

  applyEdit(input: EditDraftInput): Promise<ParsedTransactionDraft> {
    return this.provider.applyEdit(input);
  }

  refineReceiptDraft(input: RefineReceiptDraftInput): Promise<ParsedTransactionDraft> {
    return this.provider.refineReceiptDraft(input);
  }
}
