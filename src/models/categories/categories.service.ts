// api/src/categories/categories.service.ts
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuid4 } from 'uuid';
import { PG_POOL } from '@/pg/pg.module';
import { CategoryItem, CreateCategoryItem } from '@/types';
import { Tabs } from '@/enums';
import { seedCategories, DEFAULT_USER_VISIBLE_BASE_CATEGORY_NAMES } from './seed';
import { CategorizerService } from '@/categorizer/categorizer.service';
import { VALID_CATEGORY_ICONS, DEFAULT_CATEGORY_ICON } from './valid-icons.const';
import { RoomMembershipService } from '@/common/room-membership.service';

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesService.name);
  private mlRetrainInFlight = false;
  private mlRetrainQueued = false;
  private nextMlNotifyAt = 0;
  private readonly mlNotifyCooldownMs = Number(process.env.ML_NOTIFY_COOLDOWN_MS || 15000);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly categorizerService: CategorizerService,
    private readonly roomMembership: RoomMembershipService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.initDatabase();
    await this.fixInvalidIcons();
    this.notifyML().catch((err) =>
      this.logger.warn(`ML сервис недоступен при старте: ${err.message}`),
    );
  }

  /** Обновляет категории со старыми/невалидными иконками на дефолтную. */
  private async fixInvalidIcons(): Promise<void> {
    const result = await this.pool.query(
      `UPDATE categories 
       SET icon = $1 
       WHERE icon IS NULL OR icon = '' OR NOT (icon = ANY($2::text[]))
       RETURNING id, name`,
      [DEFAULT_CATEGORY_ICON, [...VALID_CATEGORY_ICONS]],
    );
    if (result.rowCount && result.rowCount > 0) {
      this.logger.log(`🔧 Исправлено иконок категорий: ${result.rowCount}`);
    }
  }

  private async notifyML(): Promise<void> {
    const now = Date.now();
    if (now < this.nextMlNotifyAt) {
      this.mlRetrainQueued = true;
      return;
    }
    if (this.mlRetrainInFlight) {
      this.mlRetrainQueued = true;
      return;
    }
    this.mlRetrainInFlight = true;
    this.nextMlNotifyAt = now + this.mlNotifyCooldownMs;
    try {
      await this.categorizerService.forceRetrain();
    } catch (err) {
      this.logger.warn(`Не удалось уведомить ML: ${(err as Error).message}`);
    } finally {
      this.mlRetrainInFlight = false;
      if (this.mlRetrainQueued) {
        this.mlRetrainQueued = false;
        setTimeout(
          () => {
            this.notifyML().catch((e) =>
              this.logger.warn(`Повторное уведомление ML не удалось: ${(e as Error).message}`),
            );
          },
          Math.max(0, this.nextMlNotifyAt - Date.now()),
        );
      }
    }
  }

  async initDatabase(): Promise<void> {
    this.logger.log('🌱 Инициализация базовых категорий...');

    for (const cat of seedCategories) {
      // Проверяем существование базовой категории (user_id IS NULL)
      const existsBase = await this.pool.query(
        'SELECT 1 FROM categories WHERE name = $1 AND user_id IS NULL',
        [cat.name],
      );
      if ((existsBase.rowCount ?? 0) === 0) {
        // Создаем базовую категорию (user_id = NULL — шаблон для всех)
        await this.pool.query(
          `INSERT INTO categories (id, name, icon, color, user_id) 
           VALUES ($1, $2, $3, $4, NULL)`,
          [cat.id, cat.name, cat.icon, cat.color],
        );

        // Добавляем примеры
        if (cat.examples) {
          for (const example of cat.examples) {
            await this.pool.query(
              `INSERT INTO examples (category_id, text, user_id) VALUES ($1, $2, NULL)`,
              [cat.id, example],
            );
          }
        }

        this.logger.log(`  ✅ ${cat.name}`);
      }
    }
  }

  async getCategories(): Promise<CategoryItem[]> {
    const { rows: categories } = await this.pool.query(`
      SELECT 
        c.id,
        c.name as title,
        c.icon,
        c.color,
        c.created_at,
        c.updated_at,
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN t.type = 'revenue' THEN t.amount ELSE 0 END), 0) as total_revenues,
        COUNT(CASE WHEN t.type = 'expense' THEN 1 END) as expense_count,
        COUNT(CASE WHEN t.type = 'revenue' THEN 1 END) as revenue_count
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id, c.name, c.icon, c.color, c.created_at, c.updated_at
      ORDER BY c.name
    `);

    const { rows: transactions } = await this.pool.query(`
      SELECT t.*, c.name as category_name
      FROM transactions t
      JOIN categories c ON t.category_id = c.id
      ORDER BY t.date DESC
    `);

    const transactionsByCategory: Record<string, any[]> = {};
    for (const t of transactions) {
      if (!transactionsByCategory[t.category_id]) {
        transactionsByCategory[t.category_id] = [];
      }
      transactionsByCategory[t.category_id].push({
        id: t.id,
        amount: t.amount,
        type: t.type,
        date: t.date,
        title: t.title ?? t.name ?? t.description ?? '',
        description: t.description,
      });
    }

    return categories.map((cat) => ({
      id: cat.id,
      title: cat.title,
      icon: cat.icon || 'category',
      color: cat.color,
      createdAt: cat.created_at?.toISOString?.() ?? cat.created_at ?? undefined,
      updatedAt: cat.updated_at?.toISOString?.() ?? cat.updated_at ?? undefined,
      totalExpenses: parseFloat(cat.total_expenses),
      totalRevenues: parseFloat(cat.total_revenues),
      expenses: transactionsByCategory[cat.id]?.filter((t) => t.type === Tabs.Expenses) || [],
      revenues: transactionsByCategory[cat.id]?.filter((t) => t.type === Tabs.Revenues) || [],
    }));
  }

  /**
   * Личные категории по умолчанию (Subscriptions, Goals) — копии глобальных шаблонов.
   * Вызывается при регистрации; без этого в списке остаются только глобальные UUID (дубликаты с копиями).
   */
  async ensureDefaultPersonalCategories(userId: string): Promise<void> {
    const names = [...DEFAULT_USER_VISIBLE_BASE_CATEGORY_NAMES];
    /**
     * Берём шаблон из глобальных категорий, если есть; иначе — фиксированные значения
     * (после удаления глобальных шаблонов миграцией).
     */
    await this.pool.query(
      `INSERT INTO categories (id, name, icon, color, user_id, updated_at)
       SELECT gen_random_uuid(), x.name, x.icon, x.color, $1::uuid, NOW()
       FROM (
         SELECT DISTINCT ON (sub.name) sub.name, sub.icon, sub.color
         FROM (
           SELECT g.name, g.icon, g.color, 0 AS ord
           FROM categories g
           WHERE g.user_id IS NULL
             AND g.group_room_id IS NULL
             AND g.name = ANY($2::text[])
           UNION ALL
           SELECT v.name, v.icon, v.color, 1
           FROM (
             VALUES
               ('Subscriptions'::text, 'subscriptions'::text, '#7C3AED'::text),
               ('Goals'::text, 'savings'::text, '#10B981'::text)
           ) AS v(name, icon, color)
           WHERE v.name = ANY($2::text[])
         ) sub
         ORDER BY sub.name, sub.ord
       ) x
       WHERE NOT EXISTS (
         SELECT 1 FROM categories c WHERE c.user_id = $1::uuid AND c.name = x.name
       )`,
      [userId, names],
    );
  }

  async getCategoriesByUserId(userId: string): Promise<CategoryItem[]> {
    const { rows: categories } = await this.pool.query(
      `WITH visible AS (
         SELECT
           c.id,
           c.name,
           c.icon,
           c.color,
           c.created_at,
           c.updated_at,
           ROW_NUMBER() OVER (
             PARTITION BY c.name
             ORDER BY CASE WHEN c.user_id = $1::uuid THEN 0 ELSE 1 END, c.created_at ASC NULLS LAST
           ) AS rn
         FROM categories c
         WHERE c.user_id = $1::uuid
            OR (
              c.user_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM categories u WHERE u.user_id = $1::uuid AND u.name = c.name
              )
              AND (
                c.name = ANY($2::text[])
                OR EXISTS (
                  SELECT 1 FROM transactions tx
                  WHERE tx.user_id = $1::uuid AND tx.category_id = c.id
                )
                OR EXISTS (
                  SELECT 1 FROM goals g
                  WHERE g.user_id = $1::uuid AND g.category_id = c.id AND g.group_room_id IS NULL
                )
                OR EXISTS (
                  SELECT 1 FROM subscriptions s
                  WHERE s.user_id = $1::uuid AND s.category_id = c.id AND s.group_room_id IS NULL
                )
              )
            )
       )
       SELECT
         v.id,
         v.name as title,
         v.icon,
         v.color,
         v.created_at,
         v.updated_at,
         COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses,
         COALESCE(SUM(CASE WHEN t.type = 'revenue' THEN t.amount ELSE 0 END), 0) as total_revenues
       FROM visible v
       LEFT JOIN transactions t ON t.category_id = v.id AND t.user_id = $1::uuid
       WHERE v.rn = 1
       GROUP BY v.id, v.name, v.icon, v.color, v.created_at, v.updated_at
       ORDER BY v.name`,
      [userId, [...DEFAULT_USER_VISIBLE_BASE_CATEGORY_NAMES]],
    );

    const { rows: transactions } = await this.pool.query(
      `SELECT t.*, c.name as category_name
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = $1
       ORDER BY t.date DESC`,
      [userId],
    );

    const transactionsByCategory: Record<string, any[]> = {};
    for (const t of transactions) {
      if (!transactionsByCategory[t.category_id]) {
        transactionsByCategory[t.category_id] = [];
      }
      transactionsByCategory[t.category_id].push({
        id: t.id,
        amount: t.amount,
        type: t.type,
        date: t.date,
        title: t.title ?? t.name ?? t.description ?? '',
        description: t.description,
      });
    }

    return categories.map((cat) => ({
      id: cat.id,
      title: cat.title,
      icon: cat.icon || 'category',
      color: cat.color,
      createdAt: cat.created_at?.toISOString?.() ?? cat.created_at ?? undefined,
      updatedAt: cat.updated_at?.toISOString?.() ?? cat.updated_at ?? undefined,
      totalExpenses: parseFloat(cat.total_expenses),
      totalRevenues: parseFloat(cat.total_revenues),
      expenses: transactionsByCategory[cat.id]?.filter((t) => t.type === Tabs.Expenses) || [],
      revenues: transactionsByCategory[cat.id]?.filter((t) => t.type === Tabs.Revenues) || [],
    }));
  }

  /** Создать в комнате дефолтные Goals и Subscriptions, если их ещё нет. */
  private async ensureGroupRoomCategoryDefaults(roomId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO categories (id, name, icon, color, user_id, group_room_id, updated_at)
       SELECT gen_random_uuid(), x.name, x.icon, x.color, NULL, $1::uuid, NOW()
       FROM (
         VALUES
           ('Goals'::text, 'savings'::text, '#10B981'::text),
           ('Subscriptions'::text, 'subscriptions'::text, '#7C3AED'::text)
       ) AS x(name, icon, color)
       WHERE NOT EXISTS (
         SELECT 1 FROM categories c
         WHERE c.group_room_id = $1::uuid AND c.name = x.name
       )`,
      [roomId],
    );
  }

  /** Все категории комнаты (`group_room_id`); глобальные шаблоны сюда не попадают. */
  async getCategoriesByRoomId(roomId: string): Promise<CategoryItem[]> {
    await this.ensureGroupRoomCategoryDefaults(roomId);
    const { rows: categories } = await this.pool.query(
      `SELECT 
        c.id,
        c.name as title,
        c.icon,
        c.color,
        c.created_at,
        c.updated_at,
        COALESCE(SUM(CASE WHEN COALESCE(gt.type::text, 'expense') = 'expense' THEN gt.amount ELSE 0 END), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN COALESCE(gt.type::text, 'expense') = 'revenue' THEN gt.amount ELSE 0 END), 0) as total_revenues
      FROM categories c
      LEFT JOIN group_transactions gt ON gt.category_id = c.id AND gt.room_id = $1
      WHERE c.group_room_id = $1
      GROUP BY c.id, c.name, c.icon, c.color, c.created_at, c.updated_at
      ORDER BY c.name`,
      [roomId],
    );

    const { rows: gtx } = await this.pool.query(
      `SELECT gt.id, gt.amount, gt.date, gt.title, gt.description, c.name as category_name, gt.category_id, gt.type
       FROM group_transactions gt
       LEFT JOIN categories c ON c.id = gt.category_id
       WHERE gt.room_id = $1
       ORDER BY gt.date DESC`,
      [roomId],
    );

    const transactionsByCategory: Record<string, any[]> = {};
    for (const t of gtx) {
      if (String(t.type ?? 'expense') === 'transfer') continue;
      const cid = t.category_id;
      if (!cid) continue;
      if (!transactionsByCategory[cid]) transactionsByCategory[cid] = [];
      const txType = String(t.type ?? 'expense') === 'revenue' ? Tabs.Revenues : Tabs.Expenses;
      transactionsByCategory[cid].push({
        id: t.id,
        amount: parseFloat(t.amount),
        type: txType,
        date: t.date instanceof Date ? t.date.toISOString().split('T')[0] : t.date,
        title: t.title ?? t.description ?? '',
        description: t.description,
      });
    }

    return categories.map((cat) => ({
      id: cat.id,
      title: cat.title,
      icon: cat.icon || 'category',
      color: cat.color,
      createdAt: cat.created_at?.toISOString?.() ?? cat.created_at ?? undefined,
      updatedAt: cat.updated_at?.toISOString?.() ?? cat.updated_at ?? undefined,
      totalExpenses: parseFloat(cat.total_expenses),
      totalRevenues: parseFloat(cat.total_revenues),
      expenses: transactionsByCategory[cat.id]?.filter((x) => x.type === Tabs.Expenses) || [],
      revenues: transactionsByCategory[cat.id]?.filter((x) => x.type === Tabs.Revenues) || [],
    }));
  }

  async getCategoriesByRoomIdForMember(roomId: string, userId: string): Promise<CategoryItem[]> {
    await this.roomMembership.assertRoomMember(roomId, userId);
    return this.getCategoriesByRoomId(roomId);
  }

  async createCategoryForRoom(
    roomId: string,
    category: CreateCategoryItem,
    actorId: string,
  ): Promise<CategoryItem> {
    await this.roomMembership.assertRoomMember(roomId, actorId);
    await this.ensureGroupRoomCategoryDefaults(roomId);

    const name = String(category.name ?? '').trim();
    if (!name) {
      throw new BadRequestException('Укажите название категории');
    }

    const id =
      category.id && CategoriesService.UUID_REGEX.test(category.id) ? category.id : uuid4();

    const exists = await this.pool.query(
      'SELECT 1 FROM categories WHERE group_room_id = $1::uuid AND name = $2',
      [roomId, name],
    );
    if ((exists?.rowCount ?? 0) > 0) {
      throw new ConflictException('В комнате уже есть категория с таким именем. Укажите другое.');
    }

    const { rows } = await this.pool.query(
      `INSERT INTO categories (id, name, icon, color, user_id, group_room_id, updated_at)
       VALUES ($1, $2, $3, $4, NULL, $5::uuid, NOW())
       RETURNING id, name as title, icon, color, created_at, updated_at`,
      [id, name, category.icon || 'category', category.color || '#CCCCCC', roomId],
    );

    if (category.examples && category.examples.length > 0) {
      for (const example of category.examples) {
        await this.pool.query(
          `INSERT INTO examples (category_id, text, user_id) VALUES ($1::uuid, $2, NULL)`,
          [id, example],
        );
      }
    }

    this.logger.log(`➕ Создана категория комнаты: ${name} (${id}) room=${roomId}`);
    this.notifyML();

    return {
      id: rows[0].id,
      title: rows[0].title,
      icon: rows[0].icon,
      color: rows[0].color,
      createdAt: rows[0].created_at?.toISOString?.() ?? rows[0].created_at ?? undefined,
      updatedAt: rows[0].updated_at?.toISOString?.() ?? rows[0].updated_at ?? undefined,
      expenses: [],
      revenues: [],
      totalExpenses: 0,
      totalRevenues: 0,
    };
  }

  async getCategoryById(id: string): Promise<CategoryItem | null> {
    const { rows } = await this.pool.query('SELECT * FROM categories WHERE id = $1', [id]);

    if (rows.length === 0) return null;

    const cat = rows[0];
    const all = await this.getCategories();
    return all.find((c) => c.id === id) || null;
  }

  async getCategoryByIdOrThrow(id: string): Promise<CategoryItem> {
    const category = await this.getCategoryById(id);
    if (!category) {
      throw new NotFoundException('Категория не найдена');
    }
    return category;
  }

  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  async createCategory(category: CreateCategoryItem, userId: string): Promise<CategoryItem> {
    // В БД id имеет тип UUID — используем переданный id только если это валидный UUID, иначе генерируем
    const id =
      category.id && CategoriesService.UUID_REGEX.test(category.id) ? category.id : uuid4();

    // Проверяем уникальность по имени у данного пользователя
    const exists = await this.pool.query(
      'SELECT 1 FROM categories WHERE user_id = $1 AND name = $2',
      [userId, category.name],
    );

    if ((exists?.rowCount ?? 0) > 0) {
      throw new ConflictException('Категория с таким именем уже существует. Укажите другое имя.');
    }

    const { rows } = await this.pool.query(
      `INSERT INTO categories (id, name, icon, color, user_id, updated_at) 
       VALUES ($1, $2, $3, $4, $5, NOW()) 
       RETURNING id, name as title, icon, color, created_at, updated_at`,
      [id, category.name, category.icon || 'category', category.color || '#CCCCCC', userId],
    );

    // Добавляем примеры
    if (category.examples && category.examples.length > 0) {
      for (const example of category.examples) {
        await this.pool.query(
          `INSERT INTO examples (category_id, text, user_id) VALUES ($1, $2, $3)`,
          [id, example, userId],
        );
      }
    }

    this.logger.log(`➕ Создана категория: ${category.name} (${id})`);
    this.notifyML();

    return {
      id: rows[0].id,
      title: rows[0].title,
      icon: rows[0].icon,
      color: rows[0].color,
      createdAt: rows[0].created_at?.toISOString?.() ?? rows[0].created_at ?? undefined,
      updatedAt: rows[0].updated_at?.toISOString?.() ?? rows[0].updated_at ?? undefined,
      expenses: [],
      revenues: [],
      totalExpenses: 0,
      totalRevenues: 0,
    };
  }

  async updateCategory(
    id: string,
    category: Partial<CreateCategoryItem>,
    userId: string,
  ): Promise<CategoryItem> {
    const meta = await this.pool.query(
      'SELECT user_id, group_room_id FROM categories WHERE id = $1',
      [id],
    );
    if ((meta.rowCount ?? 0) === 0) {
      throw new NotFoundException(`Категория с id=${id} не найдена.`);
    }
    const { user_id: ownerId, group_room_id: roomId } = meta.rows[0] as {
      user_id: string | null;
      group_room_id: string | null;
    };

    if (roomId) {
      await this.roomMembership.assertRoomMember(roomId, userId);
      const { rows } = await this.pool.query(
        `UPDATE categories 
         SET name = COALESCE($1, name), icon = COALESCE($2, icon), color = COALESCE($3, color), updated_at = NOW()
         WHERE id = $4 AND group_room_id = $5
         RETURNING id, name as title, icon, color, created_at, updated_at`,
        [category.name, category.icon, category.color, id, roomId],
      );
      if (rows.length === 0) {
        throw new NotFoundException('Категория комнаты не найдена.');
      }
      this.logger.log(`✏️ Обновлена категория комнаты: ${id}`);
      this.notifyML();
      return {
        id: rows[0].id,
        title: rows[0].title,
        icon: rows[0].icon,
        color: rows[0].color,
        createdAt: rows[0].created_at?.toISOString?.() ?? rows[0].created_at ?? undefined,
        updatedAt: rows[0].updated_at?.toISOString?.() ?? rows[0].updated_at ?? undefined,
        expenses: [],
        revenues: [],
        totalExpenses: 0,
        totalRevenues: 0,
      };
    }

    const { rows } = await this.pool.query(
      `UPDATE categories 
       SET 
         name = COALESCE($1, name),
         icon = COALESCE($2, icon),
         color = COALESCE($3, color),
         updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING id, name as title, icon, color, created_at, updated_at`,
      [category.name, category.icon, category.color, id, userId],
    );

    if (rows.length === 0) {
      if (ownerId === null) {
        throw new NotFoundException('Нельзя изменить базовую категорию. Создайте свою.');
      }
      throw new NotFoundException('Нет доступа к этой категории.');
    }

    this.logger.log(`✏️ Обновлена категория: ${id}`);
    this.notifyML();

    return {
      id: rows[0].id,
      title: rows[0].title,
      icon: rows[0].icon,
      color: rows[0].color,
      createdAt: rows[0].created_at?.toISOString?.() ?? rows[0].created_at ?? undefined,
      updatedAt: rows[0].updated_at?.toISOString?.() ?? rows[0].updated_at ?? undefined,
      expenses: [],
      revenues: [],
      totalExpenses: 0,
      totalRevenues: 0,
    };
  }

  async deleteCategory(id: string, userId: string, reassignTo?: string): Promise<void> {
    const cat = await this.pool.query(
      'SELECT id, user_id, group_room_id FROM categories WHERE id = $1',
      [id],
    );
    if ((cat.rowCount ?? 0) === 0) {
      throw new NotFoundException('Категория не найдена');
    }
    const row = cat.rows[0] as { user_id: string | null; group_room_id: string | null };
    const roomId = row.group_room_id;

    if (roomId) {
      await this.roomMembership.assertRoomMember(roomId, userId);
    } else {
      if (row.user_id === null) {
        throw new NotFoundException('Нельзя удалить базовую категорию.');
      }
      if (row.user_id !== userId) {
        throw new NotFoundException('Нет доступа к этой категории');
      }
    }

    if (reassignTo) {
      if (roomId) {
        const targetExists = await this.pool.query(
          `SELECT 1 FROM categories WHERE id = $1 AND group_room_id = $2`,
          [reassignTo, roomId],
        );
        if ((targetExists.rowCount ?? 0) === 0) {
          throw new NotFoundException(`Категория назначения ${reassignTo} не найдена`);
        }
        await this.pool.query(
          'UPDATE group_transactions SET category_id = $1 WHERE category_id = $2 AND room_id = $3',
          [reassignTo, id, roomId],
        );
        await this.pool.query(
          'UPDATE goals SET category_id = $1 WHERE category_id = $2 AND group_room_id = $3',
          [reassignTo, id, roomId],
        );
        await this.pool.query(
          'UPDATE subscriptions SET category_id = $1 WHERE category_id = $2 AND group_room_id = $3',
          [reassignTo, id, roomId],
        );
      } else {
        const targetExists = await this.pool.query(
          'SELECT 1 FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
          [reassignTo, userId],
        );
        if ((targetExists.rowCount ?? 0) === 0) {
          throw new NotFoundException(`Категория назначения ${reassignTo} не найдена`);
        }
        await this.pool.query('UPDATE transactions SET category_id = $1 WHERE category_id = $2', [
          reassignTo,
          id,
        ]);
        await this.pool.query('UPDATE goals SET category_id = $1 WHERE category_id = $2', [
          reassignTo,
          id,
        ]);
        await this.pool.query('UPDATE subscriptions SET category_id = $1 WHERE category_id = $2', [
          reassignTo,
          id,
        ]);
      }
    } else {
      if (roomId) {
        await this.pool.query(
          'DELETE FROM group_transactions WHERE category_id = $1 AND room_id = $2',
          [id, roomId],
        );
        await this.pool.query(
          'UPDATE goals SET category_id = NULL WHERE category_id = $1 AND group_room_id = $2',
          [id, roomId],
        );
        await this.pool.query(
          'UPDATE subscriptions SET category_id = NULL WHERE category_id = $1 AND group_room_id = $2',
          [id, roomId],
        );
      } else {
        await this.pool.query('DELETE FROM transactions WHERE category_id = $1', [id]);
        await this.pool.query('UPDATE goals SET category_id = NULL WHERE category_id = $1', [id]);
        await this.pool.query(
          'UPDATE subscriptions SET category_id = NULL WHERE category_id = $1',
          [id],
        );
      }
    }

    // Удаляем примеры
    await this.pool.query('DELETE FROM examples WHERE category_id = $1', [id]);

    // Удаляем категорию
    const result = await this.pool.query('DELETE FROM categories WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      throw new NotFoundException('Категория не найдена');
    }

    this.logger.log(`🗑️ Удалена категория: ${id}`);
    this.notifyML();
  }

  async addExample(categoryId: string, example: string): Promise<void> {
    const exists = await this.pool.query('SELECT 1 FROM categories WHERE id = $1', [categoryId]);

    if (exists.rowCount === 0) {
      throw new NotFoundException(
        `Категория с id=${categoryId} не найдена. Проверьте идентификатор.`,
      );
    }

    await this.pool.query(
      `INSERT INTO examples (category_id, text, user_id)
       SELECT $1::uuid, $2, c.user_id FROM categories c WHERE c.id = $1::uuid
       ON CONFLICT (category_id, text) DO NOTHING`,
      [categoryId, example],
    );

    this.logger.log(`💡 Добавлен пример "${example}" к ${categoryId}`);
    this.notifyML();
  }

  async getExamples(categoryId: string): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT text FROM examples WHERE category_id = $1', [
      categoryId,
    ]);
    return rows.map((r) => r.text);
  }
}

