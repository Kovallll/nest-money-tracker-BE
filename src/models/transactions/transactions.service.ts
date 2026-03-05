import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { Transaction, TransactionCreate } from '@/types';
import { seedTransactions } from './seed';

@Injectable()
export class TransactionsService implements OnModuleInit {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
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
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  async getTransactions(): Promise<Transaction[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM transactions ORDER BY date DESC, id DESC',
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
        ? `${base} ORDER BY t.date DESC, t.id DESC`
        : `${base} AND t.type = $2 ORDER BY t.date DESC, t.id DESC`;
    const params = type == null ? [userId] : [userId, type];
    const { rows } = await this.pool.query(query, params);
    return rows.map((r) => this.mapRow(r));
  }

  async getTransactionById(id: number): Promise<Transaction | null> {
    const { rows } = await this.pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /** Applies a balance delta to the card (positive = credit, negative = debit). */
  private async applyCardBalanceDelta(cardId: number, delta: number): Promise<void> {
    if (delta === 0) return;
    await this.pool.query(
      'UPDATE cards SET card_balance = card_balance + $1, updated_at = NOW() WHERE id = $2',
      [delta, cardId],
    );
  }

  /** Delta to apply to card balance: revenue adds, expense subtracts. */
  private static balanceDelta(type: 'expense' | 'revenue', amount: number): number {
    return type === 'revenue' ? amount : -amount;
  }

  async createTransaction(dto: TransactionCreate): Promise<Transaction> {
    const currencyCode = dto.currencyCode ?? 'BYN';
    const { rows } = await this.pool.query(
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
    if (cardId != null && !Number.isNaN(cardId)) {
      const delta = TransactionsService.balanceDelta(dto.type, dto.amount);
      await this.applyCardBalanceDelta(cardId, delta);
    }
    if (dto.categoryId) {
      await this.pool.query(
        'UPDATE categories SET updated_at = NOW() WHERE id = $1',
        [dto.categoryId],
      );
    }
    return this.mapRow(rows[0]);
  }

  async updateTransaction(
    id: number,
    dto: Partial<TransactionCreate>,
  ): Promise<Transaction | null> {
    const existing = await this.getTransactionById(id);
    if (!existing) return null;

    const oldCardId = existing.cardId ? Number(existing.cardId) : null;
    const newCardId = dto.cardId !== undefined ? (dto.cardId ? Number(dto.cardId) : null) : oldCardId;
    const newType = dto.type ?? existing.type;
    const newAmount = dto.amount ?? existing.amount;

    const { rows } = await this.pool.query(
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

    if (oldCardId != null && !Number.isNaN(oldCardId)) {
      const revertDelta = -TransactionsService.balanceDelta(existing.type, existing.amount);
      await this.applyCardBalanceDelta(oldCardId, revertDelta);
    }
    if (newCardId != null && !Number.isNaN(newCardId)) {
      const applyDelta = TransactionsService.balanceDelta(newType, newAmount);
      await this.applyCardBalanceDelta(newCardId, applyDelta);
    }

    const newCategoryId = dto.categoryId ?? existing.categoryId;
    if (newCategoryId) {
      await this.pool.query(
        'UPDATE categories SET updated_at = NOW() WHERE id = $1',
        [newCategoryId],
      );
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
    if ((result.rowCount ?? 0) > 0 && cardId != null && !Number.isNaN(cardId)) {
      const revertDelta = -TransactionsService.balanceDelta(existing.type, existing.amount);
      await this.applyCardBalanceDelta(cardId, revertDelta);
    }
    return { success: (result.rowCount ?? 0) > 0 };
  }
}

