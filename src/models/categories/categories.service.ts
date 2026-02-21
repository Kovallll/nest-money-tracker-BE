// api/src/categories/categories.service.ts
import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { CategoryItem, CreateCategoryItem } from '@/types';
import { Tabs } from '@/enums';
import { seedCategories } from './seed';
@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async initDatabase(): Promise<void> {
    this.logger.log('🌱 Инициализация базовых категорий...');

    for (const cat of seedCategories) {
      // Проверяем существование
      const exists = await this.pool.query('SELECT 1 FROM categories WHERE name = $1', [cat.name]);

      if (exists.rowCount === 0) {
        // Создаем категорию
        await this.pool.query(
          `INSERT INTO categories (id, name, icon, color) 
           VALUES ($1, $2, $3, $4)`,
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
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN t.type = 'revenue' THEN t.amount ELSE 0 END), 0) as total_revenues,
        COUNT(CASE WHEN t.type = 'expense' THEN 1 END) as expense_count,
        COUNT(CASE WHEN t.type = 'revenue' THEN 1 END) as revenue_count
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id, c.name, c.icon, c.color
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
        description: t.description,
      });
    }

    return categories.map((cat) => ({
      id: cat.id,
      title: cat.title,
      icon: cat.icon || 'pi pi-table',
      color: cat.color,
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
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses,
        COALESCE(SUM(CASE WHEN t.type = 'revenue' THEN t.amount ELSE 0 END), 0) as total_revenues
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = $1
      WHERE c.user_id = $1 OR c.user_id IS NULL
      GROUP BY c.id, c.name, c.icon, c.color
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
        description: t.description,
      });
    }

    return categories.map((cat) => ({
      id: cat.id,
      title: cat.title,
      icon: cat.icon || 'pi pi-table',
      color: cat.color,
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

  async createCategory(category: CreateCategoryItem): Promise<CategoryItem> {
    const id =
      category.id ||
      category.name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');

    // Проверяем уникальность
    const exists = await this.pool.query('SELECT 1 FROM categories WHERE id = $1 OR name = $2', [
      id,
      category.name,
    ]);

    if (exists?.rowCount ?? 0 > 0) {
      throw new ConflictException(
        'Категория с таким ID или именем уже существует. Укажите другой id или имя.',
      );
    }

    const { rows } = await this.pool.query(
      `INSERT INTO categories (id, name, icon, color) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, name as title, icon, color`,
      [id, category.name, category.icon || '📦', category.color || '#CCCCCC'],
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

    return {
      id: rows[0].id,
      title: rows[0].title,
      icon: rows[0].icon,
      color: rows[0].color,
      expenses: [],
      revenues: [],
      totalExpenses: 0,
      totalRevenues: 0,
    };
  }

  async updateCategory(id: string, category: Partial<CreateCategoryItem>): Promise<CategoryItem> {
    const { rows } = await this.pool.query(
      `UPDATE categories 
       SET 
         name = COALESCE($1, name),
         icon = COALESCE($2, icon),
         color = COALESCE($3, color),
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, name as title, icon, color`,
      [category.name, category.icon, category.color, id],
    );

    if (rows.length === 0) {
      throw new NotFoundException(
        `Категория с id=${id} не найдена. Проверьте идентификатор или создайте категорию.`,
      );
    }

    this.logger.log(`✏️ Обновлена категория: ${id}`);

    return {
      id: rows[0].id,
      title: rows[0].title,
      icon: rows[0].icon,
      color: rows[0].color,
      expenses: [],
      revenues: [],
      totalExpenses: 0,
      totalRevenues: 0,
    };
  }

  async deleteCategory(id: string): Promise<boolean> {
    // Проверяем использование в транзакциях
    const { rows: used } = await this.pool.query(
      'SELECT 1 FROM transactions WHERE category_id = $1 LIMIT 1',
      [id],
    );

    if (used.length > 0) {
      throw new ConflictException(
        'Нельзя удалить категорию: к ней привязаны транзакции. Сначала измените или удалите эти транзакции.',
      );
    }

    // Удаляем примеры
    await this.pool.query('DELETE FROM examples WHERE category_id = $1', [id]);

    // Удаляем категорию
    const result = await this.pool.query('DELETE FROM categories WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return false;
    }

    this.logger.log(`🗑️ Удалена категория: ${id}`);
    return true;
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
  }

  async getExamples(categoryId: string): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT text FROM examples WHERE category_id = $1', [
      categoryId,
    ]);
    return rows.map((r) => r.text);
  }
}

