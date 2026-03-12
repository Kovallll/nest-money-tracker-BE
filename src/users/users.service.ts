// api/src/users/users.service.ts
import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../pg/pg.module';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class UsersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  ensureCanAccessUser(currentUserId: string, targetId: string): void {
    if (currentUserId !== targetId) {
      throw new UnauthorizedException('Access denied');
    }
  }

  async getProfile(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, email, name, lastname, phone, avatar, created_at,
              analytics_snapshot_periodicity, analytics_snapshots_enabled
       FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] || null;
  }

  async getUsersWithAnalyticsSnapshotsEnabled(): Promise<
    { id: string; analytics_snapshot_periodicity: string }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT id, COALESCE(analytics_snapshot_periodicity, 'month') AS analytics_snapshot_periodicity
       FROM users
       WHERE (analytics_snapshots_enabled IS NULL OR analytics_snapshots_enabled = true)
         AND is_active = true`,
    );
    return rows.map((r: { id: string; analytics_snapshot_periodicity: string }) => ({
      id: r.id,
      analytics_snapshot_periodicity: r.analytics_snapshot_periodicity || 'month',
    }));
  }

  async updateProfile(userId: string, data: any) {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.lastname !== undefined) {
      fields.push(`lastname = $${idx++}`);
      values.push(data.lastname);
    }
    if (data.email !== undefined && data.email !== null && String(data.email).trim()) {
      const trimmed = String(data.email).trim();
      const { rows: existing } = await this.pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [trimmed, userId],
      );
      if (existing.length > 0) {
        throw new BadRequestException('Email уже занят другим пользователем');
      }
      fields.push(`email = $${idx++}`);
      values.push(trimmed);
    }
    if (data.phone !== undefined) {
      fields.push(`phone = $${idx++}`);
      values.push(data.phone);
    }
    if (data.analytics_snapshot_periodicity !== undefined) {
      const p = data.analytics_snapshot_periodicity;
      if (!['week', 'month', 'quarter'].includes(p)) {
        throw new BadRequestException(
          'analytics_snapshot_periodicity must be one of: week, month, quarter',
        );
      }
      fields.push(`analytics_snapshot_periodicity = $${idx++}`);
      values.push(p);
    }
    if (data.analytics_snapshots_enabled !== undefined) {
      fields.push(`analytics_snapshots_enabled = $${idx++}`);
      values.push(Boolean(data.analytics_snapshots_enabled));
    }

    if (fields.length === 0) {
      throw new BadRequestException(
        'Нет полей для обновления. Укажите хотя бы одно: name, lastname, email или phone.',
      );
    }

    values.push(userId);

    const { rows } = await this.pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() 
       WHERE id = $${idx} RETURNING id, email, name, lastname, phone, avatar,
               analytics_snapshot_periodicity, analytics_snapshots_enabled`,
      values,
    );

    return rows[0];
  }

  async saveAvatar(userId: string, file: any): Promise<string> {
    if (!file?.buffer && !file?.path) {
      throw new BadRequestException('No file uploaded');
    }

    const ext = path.extname(file.originalname) || '.jpg';
    const filename = `${userId}-${Date.now()}${ext}`;
    const uploadsDir = path.join(process.cwd(), 'uploads', 'avatars');

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filePath = path.join(uploadsDir, filename);
    if (file.buffer) {
      fs.writeFileSync(filePath, file.buffer);
    } else {
      fs.renameSync(file.path, filePath);
    }

    const avatarUrl = `/uploads/avatars/${filename}`;
    await this.pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarUrl, userId]);

    return avatarUrl;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    // Проверка старого пароля
    const { rows } = await this.pool.query('SELECT password_hash FROM users WHERE id = $1', [
      userId,
    ]);

    const user = rows[0];
    if (!user) throw new UnauthorizedException('Пользователь не найден');

    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) throw new UnauthorizedException('Неверный текущий пароль. Введите правильный пароль.');

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
