// api/src/categories/categories.service.ts
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { v4 as uuid4 } from 'uuid';
import { PG_POOL } from '@/pg/pg.module';
import { CategoryItem, CreateCategoryItem } from '@/types';
import { Tabs } from '@/enums';
import { seedCategories } from './seed';
import { CategorizerService } from '@/categorizer/categorizer.service';
import { VALID_CATEGORY_ICONS, DEFAULT_CATEGORY_ICON } from './valid-icons.const';

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly categorizerService: CategorizerService,
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

  private notifyML(): Promise<unknown> {
    return this.categorizerService.forceRetrain().catch((err) => {
      this.logger.warn(`Не удалось уведомить ML: ${err.message}`);
    });
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
            await this.pool.query(`INSERT INTO examples (category_id, text) VALUES ($1, $2)`, [
              cat.id,
              example,
            ]);
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

    // Получаем транзакции по категориям для детализации
    const { rows: transactions } = await this.pool.query(`
      SELECT t.*, c.name as category_name
      FROM transactions t
      JOIN categories c ON t.category_id = c.id
      ORDER BY t.date DESC
    `);

    // Группируем транзакции по категориям
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

  async getCategoriesByUserId(userId: string): Promise<CategoryItem[]> {
    const { rows: categories } = await this.pool.query(
      `SELECT 
        c.id,
        c.name as title,
        c.icon,
        c.color,
        c.created_at,
        c.updated_at,
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN t.type = 'revenue' THEN t.amount ELSE 0 END), 0) as total_revenues
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = $1
      WHERE c.user_id = $1 OR c.user_id IS NULL
      GROUP BY c.id, c.name, c.icon, c.color, c.created_at, c.updated_at
      ORDER BY c.name`,
      [userId],
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
      throw new ConflictException(
        'Категория с таким именем уже существует. Укажите другое имя.',
      );
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
        await this.pool.query(`INSERT INTO examples (category_id, text) VALUES ($1, $2)`, [
          id,
          example,
        ]);
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
    // Обновлять можно только свои категории (user_id = userId)
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
      const exists = await this.pool.query('SELECT 1 FROM categories WHERE id = $1', [id]);
      if ((exists.rowCount ?? 0) === 0) {
        throw new NotFoundException(
          `Категория с id=${id} не найдена. Проверьте идентификатор или создайте категорию.`,
        );
      }
      throw new NotFoundException('Нельзя изменить базовую категорию. Создайте свою.');
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
    // Удалять можно только свои категории (user_id = userId)
    const cat = await this.pool.query(
      'SELECT id, user_id FROM categories WHERE id = $1',
      [id],
    );
    if ((cat.rowCount ?? 0) === 0) {
      throw new NotFoundException('Категория не найдена');
    }
    if (cat.rows[0].user_id === null) {
      throw new NotFoundException('Нельзя удалить базовую категорию.');
    }
    if (cat.rows[0].user_id !== userId) {
      throw new NotFoundException('Нет доступа к этой категории');
    }

    // Опционально: переназначить транзакции/подписки/цели в другую категорию перед удалением
    if (reassignTo) {
      const targetExists = await this.pool.query(
        'SELECT 1 FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
        [reassignTo, userId],
      );
      if ((targetExists.rowCount ?? 0) === 0) {
        throw new NotFoundException(`Категория назначения ${reassignTo} не найдена`);
      }
      await this.pool.query(
        'UPDATE transactions SET category_id = $1 WHERE category_id = $2',
        [reassignTo, id],
      );
      await this.pool.query('UPDATE expenses SET category_id = $1 WHERE category_id = $2', [
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
    } else {
      // Без переназначения — удаляем связанные транзакции и расходы, цели и подписки обнуляем
      await this.pool.query('DELETE FROM transactions WHERE category_id = $1', [id]);
      await this.pool.query('DELETE FROM expenses WHERE category_id = $1', [id]);
      await this.pool.query('UPDATE goals SET category_id = NULL WHERE category_id = $1', [id]);
      await this.pool.query('UPDATE subscriptions SET category_id = NULL WHERE category_id = $1', [
        id,
      ]);
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
      `INSERT INTO examples (category_id, text) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
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

