import { BadRequestException, Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { Transaction, TransactionCreate } from '@/types';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { PredictionFeedbackService } from '@/categorizer/prediction-feedback.service';
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

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly predictionFeedback: PredictionFeedbackService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureTxAffectsCardBalanceColumn();
    await this.seedIfEmpty();
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
    type?: 'expense' | 'revenue',
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

  /** Delta to apply to card balance: revenue adds, expense subtracts (in transaction currency). */
  private static balanceDelta(type: 'expense' | 'revenue', amount: number): number {
    return type === 'revenue' ? amount : -amount;
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
    type: 'expense' | 'revenue',
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
    type: 'expense' | 'revenue',
  ): Promise<void> {
    await this.assertPersonalCardBelongsToUser(cardId, payerUserId);
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
    const currencyCode = dto.currencyCode ?? 'BYN';
    const hasAffectsCol = await this.ensureTxAffectsCardBalanceColumn();
    const affects = dto.affectsCardBalance !== false;
    const { rows } = hasAffectsCol
      ? await this.pool.query(
          `INSERT INTO transactions (user_id, card_id, category_id, type, amount, currency_code, title, description, date, payment_method, affects_card_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
          [
            dto.userId,
            dto.cardId || null,
            dto.categoryId || null,
            dto.type,
            dto.amount,
            currencyCode,
            dto.title ?? null,
            dto.description ?? null,
            dto.date,
            dto.paymentMethod ?? null,
            affects,
          ],
        )
      : await this.pool.query(
          `INSERT INTO transactions (user_id, card_id, category_id, type, amount, currency_code, title, description, date, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
          [
            dto.userId,
            dto.cardId || null,
            dto.categoryId || null,
            dto.type,
            dto.amount,
            currencyCode,
            dto.title ?? null,
            dto.description ?? null,
            dto.date,
            dto.paymentMethod ?? null,
          ],
        );
    const cardId = dto.cardId ? Number(dto.cardId) : null;
    if (cardId != null && !Number.isNaN(cardId) && (hasAffectsCol ? affects : true)) {
      const txCurrency = currencyCode;
      const delta = TransactionsService.balanceDelta(dto.type, dto.amount);
      await this.applyCardBalanceDelta(cardId, delta, txCurrency);
    }
    if (dto.categoryId) {
      await this.pool.query(
        'UPDATE categories SET updated_at = NOW() WHERE id = $1',
        [dto.categoryId],
      );
    }
    if (dto.predictionKey && dto.predictedCategoryId != null) {
      await this.predictionFeedback
        .recordFeedback(dto.predictionKey, dto.predictedCategoryId, dto.categoryId ?? null, {
          userId: dto.userId,
        })
        .catch((err) => this.logger.warn('Prediction feedback failed:', (err as Error).message));
    }
    return this.mapRow(rows[0]);
  }

  async updateTransaction(
    id: number,
    dto: UpdateTransactionDto,
  ): Promise<Transaction | null> {
    const existing = await this.getTransactionById(id);
    if (!existing) return null;

    const hasAffectsCol = await this.ensureTxAffectsCardBalanceColumn();
    const mergedAffects =
      dto.affectsCardBalance === undefined
        ? existing.affectsCardBalance !== false
        : dto.affectsCardBalance !== false;

    const oldCardId = existing.cardId ? Number(existing.cardId) : null;
    const newCardId = dto.cardId !== undefined ? (dto.cardId ? Number(dto.cardId) : null) : oldCardId;
    const newType = dto.type ?? existing.type;
    const newAmount = dto.amount ?? existing.amount;

    const { rows } = hasAffectsCol
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
            dto.cardId !== undefined ? (dto.cardId || null) : null,
            dto.categoryId || null,
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
            dto.cardId !== undefined ? (dto.cardId || null) : null,
            dto.categoryId || null,
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

    const newCurrency = dto.currencyCode ?? existing.currencyCode ?? 'BYN';
    if (oldCardId != null && !Number.isNaN(oldCardId) && existing.affectsCardBalance !== false) {
      const revertDelta = -TransactionsService.balanceDelta(existing.type, existing.amount);
      await this.applyCardBalanceDelta(oldCardId, revertDelta, existing.currencyCode ?? 'BYN');
    }
    if (newCardId != null && !Number.isNaN(newCardId) && mergedAffects) {
      const applyDelta = TransactionsService.balanceDelta(newType, newAmount);
      await this.applyCardBalanceDelta(newCardId, applyDelta, newCurrency);
    }

    const newCategoryId = dto.categoryId ?? existing.categoryId;
    if (newCategoryId) {
      await this.pool.query(
        'UPDATE categories SET updated_at = NOW() WHERE id = $1',
        [newCategoryId],
      );
    }
    if (dto.predictionKey && dto.predictedCategoryId != null) {
      await this.predictionFeedback
        .recordFeedback(dto.predictionKey, dto.predictedCategoryId, newCategoryId ?? null, {
          userId: dto.userId ?? existing.userId,
        })
        .catch((err) => this.logger.warn('Prediction feedback failed:', (err as Error).message));
    }
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
    if (
      (result.rowCount ?? 0) > 0 &&
      cardId != null &&
      !Number.isNaN(cardId) &&
      existing.affectsCardBalance !== false
    ) {
      const revertDelta = -TransactionsService.balanceDelta(existing.type, existing.amount);
      await this.applyCardBalanceDelta(cardId, revertDelta, existing.currencyCode ?? 'BYN');
    }
    return { success: (result.rowCount ?? 0) > 0 };
  }
}

