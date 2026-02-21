import { Injectable, Inject, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuid4 } from 'uuid';
import { PG_POOL } from '@/pg/pg.module';
import { GoalItem } from '@/types';
import { seedGoals } from './seed';

@Injectable()
export class GoalsService implements OnModuleInit {
  private readonly logger = new Logger(GoalsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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
        `INSERT INTO goals (id, user_id, title, target_budget, goal_budget, start_date, end_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, g.title, g.targetBudget, g.goalBudget, g.startDate, g.endDate, 'active'],
      );
    }

    this.logger.log(`✅ Создано ${seedGoals.length} целей`);
  }

  private mapRow(row: Record<string, unknown>): GoalItem {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      categoryId: (row.category_id as string) ?? null,
      title: row.title as string,
      targetBudget: parseFloat(row.target_budget as string),
      goalBudget: parseFloat(row.goal_budget as string),
      startDate:
        row.start_date instanceof Date
          ? row.start_date.toISOString().split('T')[0]
          : (row.start_date as string),
      endDate:
        row.end_date instanceof Date
          ? row.end_date.toISOString().split('T')[0]
          : (row.end_date as string),
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
      'SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => this.mapRow(r));
  }

  async getGoalById(id: string): Promise<GoalItem | null> {
    const { rows } = await this.pool.query('SELECT * FROM goals WHERE id = $1', [id]);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  async createGoal(dto: Omit<GoalItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<GoalItem> {
    const id = uuid4();
    await this.pool.query(
      `INSERT INTO goals (id, user_id, category_id, title, target_budget, goal_budget, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        dto.userId ?? null,
        dto.categoryId ?? null,
        dto.title,
        dto.targetBudget,
        dto.goalBudget,
        dto.startDate,
        dto.endDate,
        dto.status ?? 'active',
      ],
    );
    const goal = await this.getGoalById(id);
    if (!goal) throw new NotFoundException('Goal not found after create');
    return goal;
  }

  async updateGoal(id: string, dto: Partial<GoalItem>): Promise<GoalItem> {
    const existing = await this.getGoalById(id);
    if (!existing) throw new NotFoundException(`Goal with id ${id} not found`);

    const { rows } = await this.pool.query(
      `UPDATE goals
       SET user_id       = COALESCE($1, user_id),
           category_id   = COALESCE($2, category_id),
           title        = COALESCE($3, title),
           target_budget = COALESCE($4, target_budget),
           goal_budget   = COALESCE($5, goal_budget),
           start_date   = COALESCE($6, start_date),
           end_date     = COALESCE($7, end_date),
           status       = COALESCE($8, status),
           updated_at   = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        dto.userId ?? null,
        dto.categoryId ?? null,
        dto.title ?? null,
        dto.targetBudget ?? null,
        dto.goalBudget ?? null,
        dto.startDate ?? null,
        dto.endDate ?? null,
        dto.status ?? null,
        id,
      ],
    );
    return this.mapRow(rows[0]);
  }

  async deleteGoal(id: string): Promise<{ success: boolean }> {
    const result = await this.pool.query('DELETE FROM goals WHERE id = $1', [id]);
    return { success: (result.rowCount ?? 0) > 0 };
  }
}

