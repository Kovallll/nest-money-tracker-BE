import { Injectable, Inject, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuid4 } from 'uuid';
import { PG_POOL } from '@/pg/pg.module';
import { SubscribeItem } from '@/types';
import { seedSubscriptions } from './seed';

@Injectable()
export class SubscribtionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscribtionsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  private async seedIfEmpty(): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM subscriptions LIMIT 1');
    if (rowCount && rowCount > 0) return;

    const userRes = await this.pool.query('SELECT id FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      this.logger.warn('⚠️ Нет пользователей — seed подписок пропущен');
      return;
    }
    const userId: string = userRes.rows[0].id;

    this.logger.log('🌱 Создание тестовых подписок...');

    for (const s of seedSubscriptions) {
      const id = uuid4();
      await this.pool.query(
        `INSERT INTO subscriptions (id, user_id, subscribe_name, subscribe_date, amount, last_charge, type, description, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          userId,
          s.subscribeName,
          s.subscribeDate,
          s.amount,
          s.lastCharge ?? null,
          s.type,
          s.description ?? null,
          true,
        ],
      );
    }

    this.logger.log(`✅ Создано ${seedSubscriptions.length} подписок`);
  }

  private mapRow(row: Record<string, unknown>): SubscribeItem {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      categoryId: (row.category_id as string) ?? null,
      subscribeName: row.subscribe_name as string,
      subscribeDate:
        row.subscribe_date instanceof Date
          ? row.subscribe_date.toISOString().split('T')[0]
          : (row.subscribe_date as string),
      amount: parseFloat(row.amount as string),
      lastCharge:
        row.last_charge != null
          ? row.last_charge instanceof Date
            ? row.last_charge.toISOString().split('T')[0]
            : (row.last_charge as string)
          : null,
      type: (row.type as string) ?? '',
      description: (row.description as string) ?? null,
      isActive: row.is_active !== false,
      createdAt: (row.created_at as Date)?.toISOString?.() ?? undefined,
      updatedAt: (row.updated_at as Date)?.toISOString?.() ?? undefined,
    };
  }

  async getAll(): Promise<SubscribeItem[]> {
    const { rows } = await this.pool.query('SELECT * FROM subscriptions ORDER BY created_at DESC');
    return rows.map((r) => this.mapRow(r));
  }

  async getByUserId(userId: string): Promise<SubscribeItem[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getById(id: string): Promise<SubscribeItem | null> {
    const { rows } = await this.pool.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async create(dto: Omit<SubscribeItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<SubscribeItem> {
    const id = uuid4();
    await this.pool.query(
      `INSERT INTO subscriptions (id, user_id, category_id, subscribe_name, subscribe_date, amount, last_charge, type, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        dto.userId ?? null,
        dto.categoryId ?? null,
        dto.subscribeName,
        dto.subscribeDate,
        dto.amount,
        dto.lastCharge ?? null,
        dto.type ?? null,
        dto.description ?? null,
        dto.isActive !== false,
      ],
    );
    const item = await this.getById(id);
    if (!item) throw new NotFoundException('Subscription not found after create');
    return item;
  }

  async update(id: string, dto: Partial<SubscribeItem>): Promise<SubscribeItem> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundException(`Subscription with id=${id} not found`);

    const { rows } = await this.pool.query(
      `UPDATE subscriptions
       SET user_id         = COALESCE($1, user_id),
           category_id     = COALESCE($2, category_id),
           subscribe_name  = COALESCE($3, subscribe_name),
           subscribe_date  = COALESCE($4, subscribe_date),
           amount          = COALESCE($5, amount),
           last_charge     = COALESCE($6, last_charge),
           type            = COALESCE($7, type),
           description     = COALESCE($8, description),
           is_active       = COALESCE($9, is_active),
           updated_at      = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        dto.userId ?? null,
        dto.categoryId ?? null,
        dto.subscribeName ?? null,
        dto.subscribeDate ?? null,
        dto.amount ?? null,
        dto.lastCharge ?? null,
        dto.type ?? null,
        dto.description ?? null,
        dto.isActive ?? null,
        id,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const result = await this.pool.query('DELETE FROM subscriptions WHERE id = $1', [id]);
    return { success: (result.rowCount ?? 0) > 0 };
  }
}

