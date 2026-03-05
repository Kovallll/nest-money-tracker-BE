import { Injectable, Inject, Logger, OnModuleInit, BadRequestException, ForbiddenException } from '@nestjs/common';
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

    for (let i = 0; i < seedCards.length; i++) {
      const c = seedCards[i];
      const currencyCode = (c as { currencyCode?: string }).currencyCode ?? 'BYN';
      const isPrimary = i === 0;
      await this.pool.query(
        `INSERT INTO cards (user_id, card_name, card_number, card_type, bank_name, expiry, card_balance, currency_code, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [userId, c.cardName, c.cardNumber, c.cardType, c.bankName, (c as { expiry?: string }).expiry ?? null, c.cardBalance, currencyCode, isPrimary],
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
      expiry: row.expiry ?? null,
      cardBalance: parseFloat(row.card_balance),
      currencyCode: row.currency_code ?? 'BYN',
      isActive: row.is_active,
      isPrimary: row.is_primary === true,
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

  /** Returns the primary card for the user (used for automatic transactions), or null. */
  async getPrimaryCardByUserId(userId: string): Promise<BalanceCard | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM cards WHERE user_id = $1 AND is_primary = TRUE LIMIT 1',
      [userId],
    );
    if (rows.length === 0) return null;
    const card = rows[0];
    const { rows: txRows } = await this.pool.query(
      'SELECT * FROM transactions WHERE card_id = $1 ORDER BY date DESC',
      [card.id],
    );
    return this.mapRow(card, txRows.map((r: Record<string, any>) => this.mapTransaction(r)));
  }

  async getCardsByUserId(userId: string): Promise<BalanceCard[]> {
    const { rows: cards } = await this.pool.query(
      'SELECT * FROM cards WHERE user_id = $1 ORDER BY is_primary DESC, id ASC',
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

  parseCardId(id: string): number {
    const num = Number(id);
    if (Number.isNaN(num) || !Number.isInteger(num) || num < 1) {
      throw new BadRequestException(
        `Некорректный id карты: ожидается целое число больше 0. Передано: "${id}". Для списка карт пользователя используйте GET /api/balances/user/:userId`,
      );
    }
    return num;
  }

  async getCardById(id: number): Promise<BalanceCard | null> {
    const { rows } = await this.pool.query('SELECT * FROM cards WHERE id = $1', [id]);
    if (rows.length === 0) return null;

    const { rows: txRows } = await this.pool.query(
      'SELECT * FROM transactions WHERE card_id = $1 ORDER BY date DESC',
      [id],
    );

    return this.mapRow(rows[0], txRows.map((r) => this.mapTransaction(r)));
  }

  async getCard(id: string): Promise<BalanceCard | null> {
    return this.getCardById(this.parseCardId(id));
  }

  async addCard(dto: CreateCard): Promise<BalanceCard> {
    const currencyCode = dto.currencyCode ?? 'BYN';
    const existing = await this.pool.query(
      'SELECT 1 FROM cards WHERE user_id = $1 LIMIT 1',
      [dto.userId],
    );
    const isFirstCard = existing.rows.length === 0;
    const { rows } = await this.pool.query(
      `INSERT INTO cards (user_id, card_name, card_number, card_type, bank_name, expiry, card_balance, currency_code, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [dto.userId, dto.cardName, dto.cardNumber, dto.cardType, dto.bankName, dto.expiry ?? null, dto.cardBalance ?? 0, currencyCode, isFirstCard],
    );
    return this.mapRow(rows[0]);
  }

  /** Sets the card as the only primary for the user (for automatic transactions). Fails if card does not belong to user. */
  async setPrimaryCard(cardId: number, userId: string): Promise<BalanceCard | null> {
    const card = await this.getCardById(cardId);
    if (!card || card.userId !== userId) {
      throw new ForbiddenException('Card not found or access denied');
    }
    await this.pool.query(
      'UPDATE cards SET is_primary = FALSE WHERE user_id = $1',
      [userId],
    );
    await this.pool.query(
      'UPDATE cards SET is_primary = TRUE, updated_at = NOW() WHERE id = $1 AND user_id = $2',
      [cardId, userId],
    );
    return this.getCardById(cardId);
  }

  async updateCard(id: string, dto: Partial<CreateCard>): Promise<BalanceCard | null> {
    const numId = this.parseCardId(id);
    const existing = await this.getCardById(numId);
    if (!existing) return null;

    const { rows } = await this.pool.query(
      `UPDATE cards
       SET card_name     = COALESCE($1, card_name),
           card_number   = COALESCE($2, card_number),
           card_type     = COALESCE($3, card_type),
           bank_name     = COALESCE($4, bank_name),
           expiry        = COALESCE($5, expiry),
           card_balance  = COALESCE($6, card_balance),
           currency_code = COALESCE($7, currency_code),
           updated_at    = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        dto.cardName ?? null,
        dto.cardNumber ?? null,
        dto.cardType ?? null,
        dto.bankName ?? null,
        dto.expiry ?? null,
        dto.cardBalance ?? null,
        dto.currencyCode ?? null,
        numId,
      ],
    );

    return this.mapRow(rows[0]);
  }

  async deleteCard(id: string): Promise<{ success: boolean }> {
    const numId = this.parseCardId(id);
    const card = await this.getCardById(numId);
    if (!card) return { success: false };
    const wasPrimary = card.isPrimary;
    const userId = card.userId;
    const result = await this.pool.query('DELETE FROM cards WHERE id = $1', [numId]);
    if ((result.rowCount ?? 0) > 0 && wasPrimary) {
      const { rows: remaining } = await this.pool.query(
        'SELECT id FROM cards WHERE user_id = $1 ORDER BY id ASC LIMIT 1',
        [userId],
      );
      if (remaining.length > 0) {
        await this.pool.query(
          'UPDATE cards SET is_primary = TRUE, updated_at = NOW() WHERE id = $1',
          [remaining[0].id],
        );
      }
    }
    return { success: (result.rowCount ?? 0) > 0 };
  }
}
