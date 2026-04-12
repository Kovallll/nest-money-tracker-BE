import {
  BadRequestException,
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  NotFoundException,
  InternalServerErrorException,
  ForbiddenException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuid4 } from 'uuid';
import { PG_POOL } from '@/pg/pg.module';
import { GoalItem } from '@/types';
import { seedGoals } from './seed';
import { CreateGoalDto } from './dto';
import { RoomMembershipService } from '@/common/room-membership.service';

@Injectable()
export class GoalsService implements OnModuleInit {
  private readonly logger = new Logger(GoalsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly roomMembership: RoomMembershipService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  private async seedIfEmpty(): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM goals LIMIT 1');
    if (rowCount && rowCount > 0) return;

    const userRes = await this.pool.query('SELECT id FROM users LIMIT 1');
    if (userRes.rows.length === 0) {
      this.logger.warn('⚠️ Нет пользователей — seed целей пропущен');
      return;
    }
    const userId: string = userRes.rows[0].id;

    this.logger.log('🌱 Создание тестовых целей...');

    for (const g of seedGoals) {
      const id = uuid4();
      await this.pool.query(
        `INSERT INTO goals (id, user_id, group_room_id, title, target_budget, goal_budget, currency_code, start_date, end_date, status)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          userId,
          g.title,
          g.targetBudget,
          g.goalBudget,
          (g as { currencyCode?: string }).currencyCode ?? 'BYN',
          g.startDate,
          g.endDate,
          'active',
        ],
      );
    }

    this.logger.log(`✅ Создано ${seedGoals.length} целей`);
  }

  private mapRow(row: Record<string, unknown>): GoalItem {
    const num = (v: unknown): number => {
      if (typeof v === 'number' && !Number.isNaN(v)) return v;
      const n = Number(v);
      return Number.isNaN(n) ? 0 : n;
    };
    const dateStr = (v: unknown): string => {
      if (v == null) return '';
      if (v instanceof Date) return v.toISOString().split('T')[0];
      return String(v);
    };
    const endDateVal = row.end_date;
    const gid = row.group_room_id as string | null | undefined;
    return {
      id: String(row.id ?? ''),
      userId: (row.user_id as string) ?? undefined,
      groupRoomId: gid ?? null,
      categoryId: (row.category_id as string) ?? null,
      title: String(row.title ?? ''),
      targetBudget: num(row.target_budget),
      goalBudget: num(row.goal_budget),
      currencyCode: (row.currency_code as string) ?? 'BYN',
      startDate: dateStr(row.start_date),
      endDate: endDateVal == null ? undefined : dateStr(endDateVal),
      status: (row.status as string) ?? 'active',
      createdAt: (row.created_at as Date)?.toISOString?.() ?? undefined,
      updatedAt: (row.updated_at as Date)?.toISOString?.() ?? undefined,
    };
  }

  async getGoals(): Promise<GoalItem[]> {
    const { rows } = await this.pool.query('SELECT * FROM goals ORDER BY created_at DESC');
    return rows.map((r) => this.mapRow(r));
  }

  async getGoalsByUserId(userId: string): Promise<GoalItem[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM goals WHERE user_id = $1 AND group_room_id IS NULL ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getGoalsByRoomId(roomId: string): Promise<GoalItem[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM goals WHERE group_room_id = $1 ORDER BY created_at DESC',
      [roomId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getGoalsByRoomIdForMember(roomId: string, userId: string): Promise<GoalItem[]> {
    await this.roomMembership.assertRoomMember(roomId, userId);
    return this.getGoalsByRoomId(roomId);
  }

  private async assertCategoryForPersonal(userId: string, categoryId?: string | null): Promise<void> {
    if (!categoryId) return;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM categories
       WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND group_room_id IS NULL))`,
      [categoryId, userId],
    );
    if (!rows.length) {
      throw new BadRequestException('Категория недоступна для личной цели');
    }
  }

  private async assertCategoryForRoom(roomId: string, categoryId?: string | null): Promise<void> {
    if (!categoryId) return;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM categories
       WHERE id = $1 AND group_room_id = $2`,
      [categoryId, roomId],
    );
    if (!rows.length) {
      throw new BadRequestException('Категория недоступна для цели комнаты');
    }
  }

  private async assertGoalAccess(
    goal: GoalItem,
    requesterId: string,
    isService?: boolean,
  ): Promise<void> {
    if (isService) return;
    if (goal.groupRoomId) {
      await this.roomMembership.assertRoomMember(goal.groupRoomId, requesterId);
    } else if (goal.userId) {
      this.roomMembership.assertPersonalAccess(goal.userId, requesterId);
    } else {
      throw new ForbiddenException('Некорректная цель');
    }
  }

  async getGoalById(id: string): Promise<GoalItem | null> {
    const { rows } = await this.pool.query('SELECT * FROM goals WHERE id = $1', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async getGoalByIdOrThrow(id: string): Promise<GoalItem> {
    const goal = await this.getGoalById(id);
    if (!goal) throw new NotFoundException(`Goal with id ${id} not found`);
    return goal;
  }

  async createGoal(
    dto: CreateGoalDto,
    actorId: string,
    isService?: boolean,
  ): Promise<GoalItem> {
    const id = uuid4();
    const currencyCode = dto.currencyCode ?? 'BYN';
    const targetBudget = Number(dto.targetBudget);
    const goalBudget = Number(dto.goalBudget);
    if (
      Number.isNaN(targetBudget) ||
      targetBudget < 0 ||
      Number.isNaN(goalBudget) ||
      goalBudget < 0
    ) {
      throw new BadRequestException(
        'targetBudget и goalBudget должны быть неотрицательными числами',
      );
    }

    const roomId = dto.groupRoomId?.trim();
    if (roomId && dto.userId) {
      throw new BadRequestException('Укажите либо userId (личная цель), либо groupRoomId (комната)');
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

    try {
      await this.pool.query(
        `INSERT INTO goals (id, user_id, group_room_id, category_id, title, target_budget, goal_budget, currency_code, start_date, end_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          userId,
          groupRoomId,
          dto.categoryId ?? null,
          String(dto.title ?? '').trim(),
          targetBudget,
          goalBudget,
          currencyCode,
          dto.startDate ?? '',
          dto.endDate && String(dto.endDate).trim() ? dto.endDate : null,
          dto.status ?? 'active',
        ],
      );
    } catch (err) {
      const pgErr = err as { code?: string; message?: string };
      const msg = pgErr?.message ?? (err as Error)?.message ?? 'Unknown error';
      this.logger.error(`createGoal INSERT failed: ${msg}`, (err as Error)?.stack);
      // 23503 = foreign_key_violation (user_id или category_id не существует)
      if (pgErr?.code === '23503') {
        throw new BadRequestException(
          'Пользователь с указанным ID не найден. Войдите заново и попробуйте снова.',
        );
      }
      // 42703 = undefined_column (колонка не существует — нужно запустить миграцию)
      if (pgErr?.code === '42703') {
        throw new BadRequestException(
          'Таблица goals устарела. Запустите миграцию: ALTER TABLE goals ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT \'BYN\';',
        );
      }
      throw new InternalServerErrorException(
        'Не удалось создать цель. Проверьте логи сервера для деталей.',
      );
    }
    const goal = await this.getGoalById(id);
    if (!goal) throw new NotFoundException('Goal not found after create');
    return goal;
  }

  async updateGoal(
    id: string,
    dto: Partial<GoalItem>,
    actorId: string,
    isService?: boolean,
  ): Promise<GoalItem> {
    const existing = await this.getGoalById(id);
    if (!existing) throw new NotFoundException(`Goal with id ${id} not found`);
    await this.assertGoalAccess(existing, actorId, isService);

    const nextCategoryId =
      dto.categoryId !== undefined ? dto.categoryId : existing.categoryId;
    if (dto.categoryId !== undefined) {
      if (existing.groupRoomId) {
        await this.assertCategoryForRoom(existing.groupRoomId, nextCategoryId);
      } else if (existing.userId) {
        await this.assertCategoryForPersonal(existing.userId, nextCategoryId);
      }
    }

    const endDateParam =
      dto.endDate === undefined
        ? existing.endDate ?? null
        : dto.endDate && String(dto.endDate).trim()
          ? dto.endDate
          : null;
    const { rows } = await this.pool.query(
      `UPDATE goals
       SET category_id    = COALESCE($1, category_id),
           title          = COALESCE($2, title),
           target_budget  = COALESCE($3, target_budget),
           goal_budget    = COALESCE($4, goal_budget),
           currency_code  = COALESCE($5, currency_code),
           start_date     = COALESCE($6, start_date),
           end_date       = $7,
           status         = COALESCE($8, status),
           updated_at     = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        dto.categoryId ?? null,
        dto.title ?? null,
        dto.targetBudget ?? null,
        dto.goalBudget ?? null,
        dto.currencyCode ?? null,
        dto.startDate ?? null,
        endDateParam,
        dto.status ?? null,
        id,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async deleteGoal(
    id: string,
    actorId: string,
    isService?: boolean,
  ): Promise<{ success: boolean }> {
    const existing = await this.getGoalById(id);
    if (!existing) return { success: false };
    await this.assertGoalAccess(existing, actorId, isService);
    const result = await this.pool.query('DELETE FROM goals WHERE id = $1', [id]);
    return { success: (result.rowCount ?? 0) > 0 };
  }

  async getGoalByIdForRequester(
    id: string,
    requesterId: string,
    isService?: boolean,
  ): Promise<GoalItem> {
    const goal = await this.getGoalByIdOrThrow(id);
    await this.assertGoalAccess(goal, requesterId, isService);
    return goal;
  }
}

