import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { BalanceCard, CreateCard } from '@/types/models/cards';
import { Transaction } from '@/types/models/transactions';
import { seedCards } from './seed';

@Injectable()
export class CardsService implements OnModuleInit {
  private readonly logger = new Logger(CardsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  private async seedIfEmpty(): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM cards LIMIT 1');
    if (rowCount && rowCount > 0) return;

    const userRes = await this.pool.query('SELECT id FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      this.logger.warn('⚠️ Нет пользователей — seed карт пропущен');
      return;
    }
    const userId: string = userRes.rows[0].id;

    this.logger.log('🌱 Создание тестовых карт...');

    for (const c of seedCards) {
      await this.pool.query(
        `INSERT INTO cards (user_id, card_name, card_number, card_type, bank_name, branch_name, card_balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, c.cardName, c.cardNumber, c.cardType, c.bankName, c.branchName, c.cardBalance],
      );
    }

    this.logger.log(`✅ Создано ${seedCards.length} карт`);
  }

  private mapRow(row: Record<string, any>, transactions: Transaction[] = []): BalanceCard {
    return {
      id: row.id,
      userId: row.user_id,
      cardName: row.card_name,
      cardNumber: row.card_number,
      cardType: row.card_type ?? '',
      bankName: row.bank_name ?? '',
      branchName: row.branch_name ?? '',
      cardBalance: parseFloat(row.card_balance),
      isActive: row.is_active,
      transactions,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  private mapTransaction(row: Record<string, any>): Transaction {
    return {
      id: row.id,
      userId: row.user_id,
      cardId: String(row.card_id),
      categoryId: row.category_id ?? '',
      type: row.type,
      amount: parseFloat(row.amount),
      title: row.title ?? null,
      description: row.description ?? null,
      date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  async getCards(): Promise<BalanceCard[]> {
    const { rows: cards } = await this.pool.query(
      'SELECT * FROM cards ORDER BY id',
    );

    const cardIds = cards.map((c) => c.id);
    if (cardIds.length === 0) return [];

    const { rows: txRows } = await this.pool.query(
      'SELECT * FROM transactions WHERE card_id = ANY($1) ORDER BY date DESC',
      [cardIds],
    );

    const txByCard: Record<number, Transaction[]> = {};
    for (const row of txRows) {
      const cid = row.card_id;
      if (!txByCard[cid]) txByCard[cid] = [];
      txByCard[cid].push(this.mapTransaction(row));
    }

    return cards.map((c) => this.mapRow(c, txByCard[c.id] ?? []));
  }

  async getCardsByUserId(userId: string): Promise<BalanceCard[]> {
    const { rows: cards } = await this.pool.query(
      'SELECT * FROM cards WHERE user_id = $1 ORDER BY id',
      [userId],
    );

    const cardIds = cards.map((c) => c.id);
    if (cardIds.length === 0) return [];

    const { rows: txRows } = await this.pool.query(
      'SELECT * FROM transactions WHERE card_id = ANY($1) ORDER BY date DESC',
      [cardIds],
    );

    const txByCard: Record<number, Transaction[]> = {};
    for (const row of txRows) {
      const cid = row.card_id;
      if (!txByCard[cid]) txByCard[cid] = [];
      txByCard[cid].push(this.mapTransaction(row));
    }

    return cards.map((c) => this.mapRow(c, txByCard[c.id] ?? []));
  }

  async getCard(id: number): Promise<BalanceCard | null> {
    const { rows } = await this.pool.query('SELECT * FROM cards WHERE id = $1', [id]);
    if (rows.length === 0) return null;

    const { rows: txRows } = await this.pool.query(
      'SELECT * FROM transactions WHERE card_id = $1 ORDER BY date DESC',
      [id],
    );

    return this.mapRow(rows[0], txRows.map((r) => this.mapTransaction(r)));
  }

  async addCard(dto: CreateCard): Promise<BalanceCard> {
    const { rows } = await this.pool.query(
      `INSERT INTO cards (user_id, card_name, card_number, card_type, bank_name, branch_name, card_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [dto.userId, dto.cardName, dto.cardNumber, dto.cardType, dto.bankName, dto.branchName, dto.cardBalance ?? 0],
    );
    return this.mapRow(rows[0]);
  }

  async updateCard(id: number, dto: Partial<CreateCard>): Promise<BalanceCard | null> {
    const existing = await this.getCard(id);
    if (!existing) return null;

    const { rows } = await this.pool.query(
      `UPDATE cards
       SET card_name    = COALESCE($1, card_name),
           card_number  = COALESCE($2, card_number),
           card_type    = COALESCE($3, card_type),
           bank_name    = COALESCE($4, bank_name),
           branch_name  = COALESCE($5, branch_name),
           card_balance = COALESCE($6, card_balance),
           updated_at   = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        dto.cardName ?? null,
        dto.cardNumber ?? null,
        dto.cardType ?? null,
        dto.bankName ?? null,
        dto.branchName ?? null,
        dto.cardBalance ?? null,
        id,
      ],
    );

    return this.mapRow(rows[0]);
  }

  async deleteCard(id: number): Promise<{ success: boolean }> {
    const result = await this.pool.query('DELETE FROM cards WHERE id = $1', [id]);
    return { success: (result.rowCount ?? 0) > 0 };
  }
}
