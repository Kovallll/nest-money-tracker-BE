// api/src/users/users.service.ts
import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../pg/pg.module';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getProfile(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, email, name, lastname, phone, avatar, created_at 
       FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] || null;
  }

  async updateProfile(userId: string, data: any) {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name) {
      fields.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.lastname) {
      fields.push(`lastname = $${idx++}`);
      values.push(data.lastname);
    }
    if (data.phone) {
      fields.push(`phone = $${idx++}`);
      values.push(data.phone);
    }

    if (fields.length === 0) throw new Error('No fields to update');

    values.push(userId);

    const { rows } = await this.pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() 
       WHERE id = $${idx} RETURNING id, email, name, lastname, phone, avatar`,
      values,
    );

    return rows[0];
  }

  async saveAvatar(userId: string, file: any): Promise<string> {
    // Сохранение файла и получение URL
    // Здесь интеграция с S3 или локальным хранилищем
    const avatarUrl = `/uploads/avatars/${userId}-${Date.now()}.jpg`;

    await this.pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarUrl, userId]);

    return avatarUrl;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    // Проверка старого пароля
    const { rows } = await this.pool.query('SELECT password_hash FROM users WHERE id = $1', [
      userId,
    ]);

    const user = rows[0];
    if (!user) throw new UnauthorizedException('User not found');

    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) throw new UnauthorizedException('Invalid old password');

    // Обновление пароля
    const newHash = await bcrypt.hash(newPassword, 10);
    await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);

    return { success: true };
  }

  async getStats(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT 
        COUNT(*) as total_transactions,
        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expenses,
        SUM(CASE WHEN type = 'revenue' THEN amount ELSE 0 END) as total_revenues
       FROM transactions WHERE user_id = $1`,
      [userId],
    );
    return rows[0];
  }

  async deleteAccount(userId: string) {
    // Удаление связанных данных
    await this.pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await this.pool.query('DELETE FROM examples WHERE user_id = $1', [userId]);

    // Удаление пользователя
    await this.pool.query('DELETE FROM users WHERE id = $1', [userId]);

    return { deleted: true };
  }
}
