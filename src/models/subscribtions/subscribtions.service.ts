import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuid4 } from 'uuid';
import { PG_POOL } from '@/pg/pg.module';
import { SubscribeItem } from '@/types';
import { seedSubscriptions } from './seed';
import { CreateSubscriptionDto } from './dto';
import { RoomMembershipService } from '@/common/room-membership.service';

@Injectable()
export class SubscribtionsService implements OnModuleInit {
  private readonly logger = new Logger(SubscribtionsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly roomMembership: RoomMembershipService,
  ) {}

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
        `INSERT INTO subscriptions (id, user_id, group_room_id, subscribe_name, subscribe_date, amount, last_charge, type, description, is_active)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)`,
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
      userId: (row.user_id as string) ?? undefined,
      groupRoomId: (row.group_room_id as string) ?? null,
      categoryId: (row.category_id as string) ?? null,
      subscribeName: row.subscribe_name as string,
      subscribeDate:
        row.subscribe_date instanceof Date
          ? row.subscribe_date.toISOString().split('T')[0]
          : (row.subscribe_date as string),
      amount: parseFloat(row.amount as string),
      currencyCode: (row.currency_code as string) ?? 'BYN',
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

  private async assertCategoryForPersonal(userId: string, categoryId?: string | null): Promise<void> {
    if (!categoryId) return;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM categories
       WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND group_room_id IS NULL))`,
      [categoryId, userId],
    );
    if (!rows.length) throw new BadRequestException('Категория недоступна для личной подписки');
  }

  private async assertCategoryForRoom(roomId: string, categoryId?: string | null): Promise<void> {
    if (!categoryId) return;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM categories
       WHERE id = $1 AND group_room_id = $2`,
      [categoryId, roomId],
    );
    if (!rows.length) throw new BadRequestException('Категория недоступна для подписки комнаты');
  }

  private async assertSubscriptionAccess(
    sub: SubscribeItem,
    requesterId: string,
    isService?: boolean,
  ): Promise<void> {
    if (isService) return;
    if (sub.groupRoomId) {
      await this.roomMembership.assertRoomMember(sub.groupRoomId, requesterId);
    } else if (sub.userId) {
      this.roomMembership.assertPersonalAccess(sub.userId, requesterId);
    } else {
      throw new ForbiddenException('Некорректная подписка');
    }
  }

  async getAll(): Promise<SubscribeItem[]> {
    const { rows } = await this.pool.query('SELECT * FROM subscriptions ORDER BY created_at DESC');
    return rows.map((r) => this.mapRow(r));
  }

  async getByUserId(userId: string): Promise<SubscribeItem[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND group_room_id IS NULL ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getByRoomId(roomId: string): Promise<SubscribeItem[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM subscriptions WHERE group_room_id = $1 ORDER BY created_at DESC',
      [roomId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getByRoomIdForMember(roomId: string, userId: string): Promise<SubscribeItem[]> {
    await this.roomMembership.assertRoomMember(roomId, userId);
    return this.getByRoomId(roomId);
  }

  async getById(id: string): Promise<SubscribeItem | null> {
    const { rows } = await this.pool.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async getByIdOrThrow(id: string): Promise<SubscribeItem> {
    const item = await this.getById(id);
    if (!item) throw new NotFoundException(`Subscription with id=${id} not found`);
    return item;
  }

  async getByIdForRequester(
    id: string,
    requesterId: string,
    isService?: boolean,
  ): Promise<SubscribeItem> {
    const item = await this.getByIdOrThrow(id);
    await this.assertSubscriptionAccess(item, requesterId, isService);
    return item;
  }

  async create(
    dto: CreateSubscriptionDto,
    actorId: string,
    isService?: boolean,
  ): Promise<SubscribeItem> {
    const id = uuid4();
    const currencyCode = dto.currencyCode ?? 'BYN';
    const roomId = dto.groupRoomId?.trim();

    if (roomId && dto.userId) {
      throw new BadRequestException('Укажите либо userId, либо groupRoomId');
    }

    let userId: string | null = null;
    let groupRoomId: string | null = null;

    if (roomId) {
      await this.roomMembership.assertRoomMember(roomId, actorId);
      await this.assertCategoryForRoom(roomId, dto.categoryId);
      groupRoomId = roomId;
    } else {
      const uid = (dto.userId?.trim() || actorId) as string;
      this.roomMembership.assertPersonalAccess(uid, actorId, isService);
      await this.assertCategoryForPersonal(uid, dto.categoryId);
      userId = uid;
    }

    await this.pool.query(
      `INSERT INTO subscriptions (id, user_id, group_room_id, category_id, subscribe_name, subscribe_date, amount, currency_code, last_charge, type, description, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        userId,
        groupRoomId,
        dto.categoryId ?? null,
        dto.subscribeName,
        dto.subscribeDate,
        dto.amount,
        currencyCode,
        dto.lastCharge ?? null,
        dto.type ?? '',
        dto.description ?? null,
        dto.isActive !== false,
      ],
    );
    const item = await this.getById(id);
    if (!item) throw new NotFoundException('Subscription not found after create');
    return item;
  }

  async update(
    id: string,
    dto: Partial<SubscribeItem>,
    actorId: string,
    isService?: boolean,
  ): Promise<SubscribeItem> {
    const existing = await this.getById(id);
    if (!existing) throw new NotFoundException(`Subscription with id=${id} not found`);
    await this.assertSubscriptionAccess(existing, actorId, isService);

    const nextCat = dto.categoryId !== undefined ? dto.categoryId : existing.categoryId;
    if (dto.categoryId !== undefined) {
      if (existing.groupRoomId) {
        await this.assertCategoryForRoom(existing.groupRoomId, nextCat);
      } else if (existing.userId) {
        await this.assertCategoryForPersonal(existing.userId, nextCat);
      }
    }

    const { rows } = await this.pool.query(
      `UPDATE subscriptions
       SET category_id     = COALESCE($1, category_id),
           subscribe_name  = COALESCE($2, subscribe_name),
           subscribe_date  = COALESCE($3, subscribe_date),
           amount          = COALESCE($4, amount),
           currency_code   = COALESCE($5, currency_code),
           last_charge     = COALESCE($6, last_charge),
           type            = COALESCE($7, type),
           description     = COALESCE($8, description),
           is_active       = COALESCE($9, is_active),
           updated_at      = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        dto.categoryId ?? null,
        dto.subscribeName ?? null,
        dto.subscribeDate ?? null,
        dto.amount ?? null,
        dto.currencyCode ?? null,
        dto.lastCharge ?? null,
        dto.type ?? null,
        dto.description ?? null,
        dto.isActive ?? null,
        id,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async delete(
    id: string,
    actorId: string,
    isService?: boolean,
  ): Promise<{ success: boolean }> {
    const existing = await this.getById(id);
    if (!existing) return { success: false };
    await this.assertSubscriptionAccess(existing, actorId, isService);
    const result = await this.pool.query('DELETE FROM subscriptions WHERE id = $1', [id]);
    return { success: (result.rowCount ?? 0) > 0 };
  }
}
