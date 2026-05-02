import { BadRequestException, Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { Transaction, TransactionCreate } from '@/types';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { PredictionFeedbackService } from '@/categorizer/prediction-feedback.service';
import { AiInsightsService } from '@/ai-insights/ai-insights.service';
import { seedTransactions } from './seed';

interface CreateTransactionDto extends TransactionCreate {
  predictionKey?: string;
  predictedCategoryId?: string;
}

interface UpdateTransactionDto extends Partial<TransactionCreate> {
  predictionKey?: string;
  predictedCategoryId?: string;
}

@Injectable()
export class TransactionsService implements OnModuleInit {
  private readonly logger = new Logger(TransactionsService.name);
  private txAffectsColState: 'unknown' | 'yes' | 'no' = 'unknown';
  private transferToCardIdColExists = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly predictionFeedback: PredictionFeedbackService,
    private readonly aiInsights: AiInsightsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureTxAffectsCardBalanceColumn();
    this.transferToCardIdColExists = await this.queryTransferToCardIdColumnExists();
    await this.seedIfEmpty();
  }

  private async queryTransferToCardIdColumnExists(): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'transfer_to_card_id'
       LIMIT 1`,
    );
    return (rows?.length ?? 0) > 0;
  }

  private async queryTxAffectsColExists(): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'transactions'
         AND column_name = 'affects_card_balance'
       LIMIT 1`,
    );
    return rows.length > 0;
  }

  private async tryAddTxAffectsColumn(): Promise<void> {
    try {
      await this.pool.query(
        `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS affects_card_balance BOOLEAN NOT NULL DEFAULT TRUE`,
      );
    } catch (err) {
      this.logger.warn(`transactions ADD affects_card_balance: ${(err as Error).message}`);
    }
  }

  /** Колонка: учитывать ли транзакцию в балансе карты. */
  async ensureTxAffectsCardBalanceColumn(): Promise<boolean> {
    if (this.txAffectsColState === 'yes') return true;
    if (this.txAffectsColState === 'no') return false;

    if (await this.queryTxAffectsColExists()) {
      this.txAffectsColState = 'yes';
      return true;
    }
    await this.tryAddTxAffectsColumn();
    if (await this.queryTxAffectsColExists()) {
      this.txAffectsColState = 'yes';
      this.logger.log('transactions.affects_card_balance готова');
      return true;
    }
    this.txAffectsColState = 'no';
    this.logger.warn(
      'transactions.affects_card_balance отсутствует; списание с карты всегда применяется до миграции БД',
    );
    return false;
  }

  private async seedIfEmpty(): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM transactions LIMIT 1');
    if (rowCount && rowCount > 0) return;

    const userRes = await this.pool.query('SELECT id FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      this.logger.warn('⚠️ Нет пользователей — seed транзакций пропущен');
      return;
    }
    const userId: string = userRes.rows[0].id;

    const cardRes = await this.pool.query(
      'SELECT id FROM cards WHERE user_id = $1 ORDER BY is_primary DESC, id ASC LIMIT 1',
      [userId],
    );
    if (cardRes.rows.length === 0) {
      this.logger.warn('⚠️ Нет карт у пользователя — seed транзакций пропущен');
      return;
    }
    const cardId: string = String(cardRes.rows[0].id);

    this.logger.log('🌱 Создание базовых транзакций...');

    for (const t of seedTransactions) {
      let categoryId: string = '';

      if (t.categoryName) {
        const cat = await this.pool.query(
          'SELECT id FROM categories WHERE name = $1 AND user_id IS NULL LIMIT 1',
          [t.categoryName],
        );
        categoryId = cat.rows[0]?.id ?? '';
      }

      const currencyCode = (t as { currencyCode?: string }).currencyCode ?? 'BYN';
      await this.pool.query(
        `INSERT INTO transactions (user_id, card_id, category_id, type, amount, currency_code, title, description, date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          cardId,
          categoryId || null,
          t.type,
          t.amount,
          currencyCode,
          t.title,
          t.description ?? null,
          t.date,
        ],
      );
    }

    this.logger.log(`✅ Создано ${seedTransactions.length} транзакций`);
  }

  private mapRow(row: Record<string, any>): Transaction {
    return {
      id: row.id,
      userId: row.user_id,
      cardId: String(row.card_id),
      transferToCardId: row.transfer_to_card_id != null ? String(row.transfer_to_card_id) : null,
      categoryId: row.category_id ?? '',
      category: row.category_name ?? row.category ?? null,
      type: row.type,
      amount: parseFloat(row.amount),
      currencyCode: row.currency_code ?? 'BYN',
      title: row.title ?? null,
      description: row.description ?? null,
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
      paymentMethod: row.payment_method ?? null,
      affectsCardBalance:
        row.affects_card_balance === undefined ? true : row.affects_card_balance !== false,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  async getTransactions(): Promise<Transaction[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM transactions ORDER BY created_at DESC, id DESC',
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getTransactionsByUserId(
    userId: string,
    type?: 'expense' | 'revenue' | 'transfer',
  ): Promise<Transaction[]> {
    const base =
      'SELECT t.*, c.name as category_name FROM transactions t LEFT JOIN categories c ON t.category_id = c.id WHERE t.user_id = $1';
    const query =
      type == null
        ? `${base} ORDER BY t.created_at DESC, t.id DESC`
        : `${base} AND t.type = $2 ORDER BY t.created_at DESC, t.id DESC`;
    const params = type == null ? [userId] : [userId, type];
    const { rows } = await this.pool.query(query, params);
    return rows.map((r) => this.mapRow(r));
  }

  async getTransactionById(id: number): Promise<Transaction | null> {
    const { rows } = await this.pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  private async getCardCurrencyCode(cardId: number): Promise<string> {
    const { rows } = await this.pool.query<{ currency_code: string }>(
      'SELECT currency_code FROM cards WHERE id = $1',
      [cardId],
    );
    return rows[0]?.currency_code ?? 'BYN';
  }

  private async getCardSnapshot(
    cardId: number,
  ): Promise<{ cardBalance: number; currencyCode: string } | null> {
    const { rows } = await this.pool.query<{
      card_balance: string | number;
      currency_code: string;
    }>('SELECT card_balance, currency_code FROM cards WHERE id = $1 LIMIT 1', [cardId]);
    if (!rows[0]) return null;
    return {
      cardBalance: Number(rows[0].card_balance) || 0,
      currencyCode: rows[0].currency_code ?? 'BYN',
    };
  }

  /**
   * Добавляет текст транзакции в examples выбранной категории (если еще нет).
   * Это помогает ML учиться на реальном выборе пользователя.
   */
  private async addCategoryExampleFromTransaction(
    categoryId: string | null | undefined,
    title: string | null | undefined,
  ): Promise<void> {
    const cid = String(categoryId ?? '').trim();
    const text = String(title ?? '').trim();
    if (!cid || !text || text.length < 2) return;
    await this.pool.query(
      `INSERT INTO examples (category_id, text, user_id)
       SELECT $1::uuid, $2, c.user_id
       FROM categories c
       WHERE c.id = $1::uuid
       ON CONFLICT (category_id, text) DO NOTHING`,
      [cid, text],
    );
  }

  /**
   * Проверка, что списание не уводит карту в отрицательный баланс.
   * debitAmountInTransactionCurrency должен быть > 0.
   */
  async assertCardHasSufficientFunds(
    cardId: number,
    debitAmountInTransactionCurrency: number,
    transactionCurrency: string,
  ): Promise<void> {
    if (!(debitAmountInTransactionCurrency > 0)) return;
    const snapshot = await this.getCardSnapshot(cardId);
    if (!snapshot) {
      throw new BadRequestException('Карта не найдена');
    }
    const debitInCardCurrency = this.exchangeRates.convert(
      debitAmountInTransactionCurrency,
      transactionCurrency,
      snapshot.currencyCode,
    );
    const nextBalance = snapshot.cardBalance - debitInCardCurrency;
    if (nextBalance < 0) {
      throw new BadRequestException(
        `Недостаточно средств на карте: после операции баланс был бы отрицательным (${nextBalance.toFixed(2)} ${snapshot.currencyCode})`,
      );
    }
  }

  /**
   * Applies a balance delta to the card. Converts delta from transactionCurrency to card currency.
   * Positive delta = credit, negative = debit.
   */
  private async applyCardBalanceDelta(
    cardId: number,
    deltaInTransactionCurrency: number,
    transactionCurrency: string,
  ): Promise<void> {
    if (deltaInTransactionCurrency === 0) return;
    const cardCurrency = await this.getCardCurrencyCode(cardId);
    const deltaInCardCurrency = this.exchangeRates.convert(
      deltaInTransactionCurrency,
      transactionCurrency,
      cardCurrency,
    );
    if (deltaInCardCurrency === 0) return;
    await this.pool.query(
      'UPDATE cards SET card_balance = card_balance + $1, updated_at = NOW() WHERE id = $2',
      [deltaInCardCurrency, cardId],
    );
  }

  /** Delta to apply to one card: revenue adds, expense subtracts; transfer uses {@link applyTransferBetweenCards}. */
  private static balanceDelta(type: 'expense' | 'revenue' | 'transfer', amount: number): number {
    if (type === 'revenue') return amount;
    if (type === 'expense') return -amount;
    return 0;
  }

  /** direction 1 = выполнить перевод, -1 = откатить. */
  async applyTransferBetweenCards(
    sourceCardId: number,
    targetCardId: number,
    amount: number,
    currencyCode: string,
    direction: 1 | -1,
  ): Promise<void> {
    await this.applyCardBalanceDelta(sourceCardId, direction * -amount, currencyCode);
    await this.applyCardBalanceDelta(targetCardId, direction * amount, currencyCode);
  }

  /**
   * Проверка, что карта принадлежит пользователю (личные карты из «личного» аккаунта).
   */
  async assertPersonalCardBelongsToUser(cardId: number, userId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM cards WHERE id = $1 AND user_id = $2',
      [cardId, userId],
    );
    if (!rowCount) {
      throw new BadRequestException('Карта не найдена или не принадлежит плательщику');
    }
  }

  /**
   * Групповая транзакция с личной карты: изменить баланс как у личного expense/revenue.
   */
  async applyPersonalCardForGroupTx(
    payerUserId: string,
    cardId: number,
    amount: number,
    currencyCode: string,
    type: 'expense' | 'revenue' | 'transfer',
  ): Promise<void> {
    await this.assertPersonalCardBelongsToUser(cardId, payerUserId);
    const delta = TransactionsService.balanceDelta(type, amount);
    await this.applyCardBalanceDelta(cardId, delta, currencyCode);
  }

  /** Откат эффекта {@link applyPersonalCardForGroupTx} при удалении групповой транзакции. */
  async reversePersonalCardForGroupTx(
    payerUserId: string,
    cardId: number,
    amount: number,
    currencyCode: string,
    type: 'expense' | 'revenue' | 'transfer',
  ): Promise<void> {
    await this.assertPersonalCardBelongsToUser(cardId, payerUserId);
    if (type === 'transfer') {
      this.logger.warn(
        'reversePersonalCardForGroupTx: transfer с одной картой — используйте пару карт',
      );
      return;
    }
    const reverseType = type === 'expense' ? 'revenue' : 'expense';
    const delta = TransactionsService.balanceDelta(reverseType, amount);
    await this.applyCardBalanceDelta(cardId, delta, currencyCode);
  }

  /**
   * Групповой расход, оплаченный с личной карты участника: уменьшить баланс карты (как expense).
   */
  async applyPersonalCardForGroupExpense(
    payerUserId: string,
    cardId: number,
    amount: number,
    currencyCode: string,
  ): Promise<void> {
    await this.applyPersonalCardForGroupTx(payerUserId, cardId, amount, currencyCode, 'expense');
  }

  /**
   * Откат эффекта {@link applyPersonalCardForGroupExpense} (например, при удалении групповой транзакции).
   */
  async reversePersonalCardForGroupExpense(
    payerUserId: string,
    cardId: number,
    amount: number,
    currencyCode: string,
  ): Promise<void> {
    await this.reversePersonalCardForGroupTx(payerUserId, cardId, amount, currencyCode, 'expense');
  }

  async createTransaction(dto: CreateTransactionDto): Promise<Transaction> {
    if (dto.type === 'transfer' && !this.transferToCardIdColExists) {
      throw new BadRequestException(
        'Переводы между картами недоступны: в таблице transactions нет колонки transfer_to_card_id.',
      );
    }
    if (dto.type === 'transfer') {
      const src = Number(dto.cardId);
      const dst = Number(dto.transferToCardId);
      if (!Number.isFinite(src) || src < 1 || !Number.isFinite(dst) || dst < 1) {
        throw new BadRequestException('Для перевода укажите карту списания и карту зачисления');
      }
      if (src === dst) {
        throw new BadRequestException('Нельзя перевести на ту же карту');
      }
      await this.assertPersonalCardBelongsToUser(src, dto.userId);
      await this.assertPersonalCardBelongsToUser(dst, dto.userId);
    }

    const currencyCode = dto.currencyCode ?? 'BYN';
    const hasAffectsCol = await this.ensureTxAffectsCardBalanceColumn();
    const affects = dto.affectsCardBalance !== false;
    const categoryIdForRow =
      dto.type === 'transfer'
        ? dto.categoryId?.trim()
          ? dto.categoryId.trim()
          : null
        : dto.categoryId || null;
    const transferToId =
      dto.type === 'transfer' && dto.transferToCardId ? Number(dto.transferToCardId) : null;

    let insertResult;
    if (hasAffectsCol && this.transferToCardIdColExists) {
      insertResult = await this.pool.query(
        `INSERT INTO transactions (user_id, card_id, category_id, type, amount, currency_code, title, description, date, payment_method, affects_card_balance, transfer_to_card_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          dto.userId,
          dto.cardId || null,
          categoryIdForRow,
          dto.type,
          dto.amount,
          currencyCode,
          dto.title ?? null,
          dto.description ?? null,
          dto.date,
          dto.paymentMethod ?? null,
          affects,
          transferToId,
        ],
      );
    } else if (hasAffectsCol) {
      insertResult = await this.pool.query(
        `INSERT INTO transactions (user_id, card_id, category_id, type, amount, currency_code, title, description, date, payment_method, affects_card_balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          dto.userId,
          dto.cardId || null,
          categoryIdForRow,
          dto.type,
          dto.amount,
          currencyCode,
          dto.title ?? null,
          dto.description ?? null,
          dto.date,
          dto.paymentMethod ?? null,
          affects,
        ],
      );
    } else {
      insertResult = await this.pool.query(
        `INSERT INTO transactions (user_id, card_id, category_id, type, amount, currency_code, title, description, date, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          dto.userId,
          dto.cardId || null,
          categoryIdForRow,
          dto.type,
          dto.amount,
          currencyCode,
          dto.title ?? null,
          dto.description ?? null,
          dto.date,
          dto.paymentMethod ?? null,
        ],
      );
    }
    const { rows } = insertResult;

    const cardId = dto.cardId ? Number(dto.cardId) : null;
    const applyBalances = hasAffectsCol ? affects : true;
    if (applyBalances) {
      if (dto.type === 'expense' && cardId != null && !Number.isNaN(cardId)) {
        await this.assertCardHasSufficientFunds(cardId, dto.amount, currencyCode);
      }
      if (dto.type === 'transfer' && cardId != null && !Number.isNaN(cardId)) {
        await this.assertCardHasSufficientFunds(cardId, dto.amount, currencyCode);
      }
    }
    if (
      dto.type === 'transfer' &&
      cardId != null &&
      !Number.isNaN(cardId) &&
      transferToId != null &&
      !Number.isNaN(transferToId) &&
      applyBalances
    ) {
      await this.applyTransferBetweenCards(cardId, transferToId, dto.amount, currencyCode, 1);
    } else if (
      dto.type !== 'transfer' &&
      cardId != null &&
      !Number.isNaN(cardId) &&
      applyBalances
    ) {
      const delta = TransactionsService.balanceDelta(dto.type, dto.amount);
      await this.applyCardBalanceDelta(cardId, delta, currencyCode);
    }
    if (dto.categoryId?.trim()) {
      await this.pool.query('UPDATE categories SET updated_at = NOW() WHERE id = $1', [
        dto.categoryId.trim(),
      ]);
      await this.addCategoryExampleFromTransaction(dto.categoryId, dto.title);
    }
    if (dto.predictionKey && dto.predictedCategoryId != null) {
      await this.predictionFeedback
        .recordFeedback(dto.predictionKey, dto.predictedCategoryId, dto.categoryId ?? null, {
          userId: dto.userId,
        })
        .catch((err) => this.logger.warn('Prediction feedback failed:', (err as Error).message));
    }
    this.aiInsights
      .recomputeUserInsights(dto.userId, 'tx_create')
      .catch((err) =>
        this.logger.warn(`Ai insights recompute failed after create: ${(err as Error).message}`),
      );
    return this.mapRow(rows[0]);
  }

  async updateTransaction(id: number, dto: UpdateTransactionDto): Promise<Transaction | null> {
    const existing = await this.getTransactionById(id);
    if (!existing) return null;

    const hasAffectsCol = await this.ensureTxAffectsCardBalanceColumn();
    const mergedAffects =
      dto.affectsCardBalance === undefined
        ? existing.affectsCardBalance !== false
        : dto.affectsCardBalance !== false;

    const mergedType = dto.type ?? existing.type;
    const mergedAmount = dto.amount ?? existing.amount;
    const nextTransferToId =
      mergedType === 'transfer'
        ? dto.transferToCardId !== undefined
          ? dto.transferToCardId
            ? Number(dto.transferToCardId)
            : null
          : existing.transferToCardId
            ? Number(existing.transferToCardId)
            : null
        : null;

    if (mergedType === 'transfer') {
      if (!this.transferToCardIdColExists) {
        throw new BadRequestException('Переводы недоступны: нет колонки transfer_to_card_id.');
      }
      const src = dto.cardId !== undefined ? Number(dto.cardId || 0) : Number(existing.cardId || 0);
      const dst = nextTransferToId;
      if (!Number.isFinite(src) || src < 1 || dst == null || !Number.isFinite(dst) || dst < 1) {
        throw new BadRequestException('Для перевода укажите две карты');
      }
      if (src === dst) {
        throw new BadRequestException('Нельзя перевести на ту же карту');
      }
      const uid = dto.userId ?? existing.userId;
      await this.assertPersonalCardBelongsToUser(src, uid);
      await this.assertPersonalCardBelongsToUser(dst, uid);
    }

    const { rows } =
      hasAffectsCol && this.transferToCardIdColExists
        ? await this.pool.query(
            `UPDATE transactions
         SET user_id         = COALESCE($1, user_id),
             card_id         = COALESCE($2, card_id),
             category_id     = COALESCE($3, category_id),
             type            = COALESCE($4, type),
             amount          = COALESCE($5, amount),
             currency_code   = COALESCE($6, currency_code),
             title           = COALESCE($7, title),
             description     = COALESCE($8, description),
             date            = COALESCE($9, date),
             payment_method  = COALESCE($10, payment_method),
             affects_card_balance = $11,
             transfer_to_card_id = $12,
             updated_at      = NOW()
         WHERE id = $13
         RETURNING *`,
            [
              dto.userId ?? null,
              dto.cardId !== undefined ? dto.cardId || null : null,
              dto.categoryId !== undefined ? dto.categoryId || null : null,
              dto.type ?? null,
              dto.amount ?? null,
              dto.currencyCode ?? null,
              dto.title ?? null,
              dto.description ?? null,
              dto.date ?? null,
              dto.paymentMethod ?? null,
              mergedAffects,
              nextTransferToId,
              id,
            ],
          )
        : hasAffectsCol
          ? await this.pool.query(
              `UPDATE transactions
         SET user_id         = COALESCE($1, user_id),
             card_id         = COALESCE($2, card_id),
             category_id     = COALESCE($3, category_id),
             type            = COALESCE($4, type),
             amount          = COALESCE($5, amount),
             currency_code   = COALESCE($6, currency_code),
             title           = COALESCE($7, title),
             description     = COALESCE($8, description),
             date            = COALESCE($9, date),
             payment_method  = COALESCE($10, payment_method),
             affects_card_balance = $11,
             updated_at      = NOW()
         WHERE id = $12
         RETURNING *`,
              [
                dto.userId ?? null,
                dto.cardId !== undefined ? dto.cardId || null : null,
                dto.categoryId !== undefined ? dto.categoryId || null : null,
                dto.type ?? null,
                dto.amount ?? null,
                dto.currencyCode ?? null,
                dto.title ?? null,
                dto.description ?? null,
                dto.date ?? null,
                dto.paymentMethod ?? null,
                mergedAffects,
                id,
              ],
            )
          : await this.pool.query(
              `UPDATE transactions
         SET user_id         = COALESCE($1, user_id),
             card_id         = COALESCE($2, card_id),
             category_id     = COALESCE($3, category_id),
             type            = COALESCE($4, type),
             amount          = COALESCE($5, amount),
             currency_code   = COALESCE($6, currency_code),
             title           = COALESCE($7, title),
             description     = COALESCE($8, description),
             date            = COALESCE($9, date),
             payment_method  = COALESCE($10, payment_method),
             updated_at      = NOW()
         WHERE id = $11
         RETURNING *`,
              [
                dto.userId ?? null,
                dto.cardId !== undefined ? dto.cardId || null : null,
                dto.categoryId !== undefined ? dto.categoryId || null : null,
                dto.type ?? null,
                dto.amount ?? null,
                dto.currencyCode ?? null,
                dto.title ?? null,
                dto.description ?? null,
                dto.date ?? null,
                dto.paymentMethod ?? null,
                id,
              ],
            );

    const oldCur = existing.currencyCode ?? 'BYN';
    if (existing.affectsCardBalance !== false) {
      if (existing.type === 'transfer') {
        const os = existing.cardId ? Number(existing.cardId) : null;
        const ot = existing.transferToCardId ? Number(existing.transferToCardId) : null;
        if (os != null && ot != null && !Number.isNaN(os) && !Number.isNaN(ot)) {
          await this.applyTransferBetweenCards(os, ot, existing.amount, oldCur, -1);
        }
      } else {
        const oldCardId = existing.cardId ? Number(existing.cardId) : null;
        if (oldCardId != null && !Number.isNaN(oldCardId)) {
          const revertDelta = -TransactionsService.balanceDelta(existing.type, existing.amount);
          await this.applyCardBalanceDelta(oldCardId, revertDelta, oldCur);
        }
      }
    }

    const updated = this.mapRow(rows[0]);
    const newCur = updated.currencyCode ?? 'BYN';
    if (mergedAffects) {
      if (updated.type === 'transfer') {
        const ns = updated.cardId ? Number(updated.cardId) : null;
        const nt = updated.transferToCardId ? Number(updated.transferToCardId) : null;
        if (ns != null && nt != null && !Number.isNaN(ns) && !Number.isNaN(nt)) {
          await this.applyTransferBetweenCards(ns, nt, updated.amount, newCur, 1);
        }
      } else {
        const newCardId = updated.cardId ? Number(updated.cardId) : null;
        if (newCardId != null && !Number.isNaN(newCardId)) {
          const applyDelta = TransactionsService.balanceDelta(updated.type, updated.amount);
          await this.applyCardBalanceDelta(newCardId, applyDelta, newCur);
        }
      }
    }

    const newCategoryId = dto.categoryId ?? existing.categoryId;
    const newTitle = dto.title ?? existing.title ?? null;
    if (newCategoryId) {
      await this.pool.query('UPDATE categories SET updated_at = NOW() WHERE id = $1', [
        newCategoryId,
      ]);
      await this.addCategoryExampleFromTransaction(newCategoryId, newTitle);
    }
    if (dto.predictionKey && dto.predictedCategoryId != null) {
      await this.predictionFeedback
        .recordFeedback(dto.predictionKey, dto.predictedCategoryId, newCategoryId ?? null, {
          userId: dto.userId ?? existing.userId,
        })
        .catch((err) => this.logger.warn('Prediction feedback failed:', (err as Error).message));
    }
    this.aiInsights
      .recomputeUserInsights(dto.userId ?? existing.userId, 'tx_update')
      .catch((err) =>
        this.logger.warn(`Ai insights recompute failed after update: ${(err as Error).message}`),
      );
    return this.mapRow(rows[0]);
  }

  async deleteTransaction(id: number): Promise<{ success: boolean }> {
    const existing = await this.getTransactionById(id);
    if (!existing) {
      const result = await this.pool.query('DELETE FROM transactions WHERE id = $1', [id]);
      return { success: (result.rowCount ?? 0) > 0 };
    }
    const cardId = existing.cardId ? Number(existing.cardId) : null;
    const result = await this.pool.query('DELETE FROM transactions WHERE id = $1', [id]);
    if ((result.rowCount ?? 0) > 0 && existing.affectsCardBalance !== false) {
      const cur = existing.currencyCode ?? 'BYN';
      if (existing.type === 'transfer') {
        const os = existing.cardId ? Number(existing.cardId) : null;
        const ot = existing.transferToCardId ? Number(existing.transferToCardId) : null;
        if (os != null && ot != null && !Number.isNaN(os) && !Number.isNaN(ot)) {
          await this.applyTransferBetweenCards(os, ot, existing.amount, cur, -1);
        }
      } else if (cardId != null && !Number.isNaN(cardId)) {
        const revertDelta = -TransactionsService.balanceDelta(existing.type, existing.amount);
        await this.applyCardBalanceDelta(cardId, revertDelta, cur);
      }
    }
    if ((result.rowCount ?? 0) > 0) {
      this.aiInsights
        .recomputeUserInsights(existing.userId, 'tx_delete')
        .catch((err) =>
          this.logger.warn(`Ai insights recompute failed after delete: ${(err as Error).message}`),
        );
    }
    return { success: (result.rowCount ?? 0) > 0 };
  }
}

