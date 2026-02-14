// api/src/auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../pg/pg.module';
import * as bcrypt from 'bcrypt';
import { PushService } from '@/push/push.service';
import { v4 as uuid4 } from 'uuid';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
    private readonly pushService: PushService,
  ) {}

  async register(email: string, password: string, name: string) {
    // Проверка существования
    const { rows: existing } = await this.pool.query('SELECT 1 FROM users WHERE email = $1', [
      email,
    ]);

    if (existing.length > 0) {
      throw new UnauthorizedException('Пользователь уже существует');
    }

    // Хеширование пароля
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuid4();

    // Создание пользователя
    await this.pool.query(
      `INSERT INTO users (id, email, name, password_hash, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [userId, email, name, passwordHash],
    );

    // Генерация токенов
    const tokens = await this.generateTokens(userId, email);

    return {
      user: { id: userId, email, name },
      ...tokens,
    };
  }

  async login(email: string, password: string, pushSubscription?: any, userAgent?: string) {
    // Поиск пользователя
    const { rows } = await this.pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email],
    );

    const user = rows[0];
    if (!user) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    // Проверка пароля
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    // Обновление last_login
    await this.pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Автоподписка на push если передана
    if (pushSubscription) {
      await this.pushService.saveSubscription(user.id, pushSubscription, userAgent || 'unknown');
    }

    // Генерация токенов
    const tokens = await this.generateTokens(user.id, user.email);

    return {
      user: { id: user.id, email: user.email, name: user.name },
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    // Проверка refresh token
    const { rows } = await this.pool.query(
      'SELECT id, email, name FROM users WHERE refresh_token = $1 AND token_expires > NOW()',
      [refreshToken],
    );

    const user = rows[0];
    if (!user) {
      throw new UnauthorizedException('Недействительный refresh token');
    }

    // Генерация новых токенов
    const tokens = await this.generateTokens(user.id, user.email);

    return {
      user: { id: user.id, email: user.email, name: user.name },
      ...tokens,
    };
  }

  async logout(userId: string) {
    await this.pool.query(
      'UPDATE users SET refresh_token = NULL, token_expires = NULL WHERE id = $1',
      [userId],
    );
    return { success: true };
  }

  private async generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    // Access token (15 минут)
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '15m',
    });

    // Refresh token (7 дней)
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '7d',
      secret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    });

    // Сохранение refresh token в БД
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.pool.query('UPDATE users SET refresh_token = $1, token_expires = $2 WHERE id = $3', [
      refreshToken,
      expiresAt,
      userId,
    ]);

    return { accessToken, refreshToken };
  }

  async validateUser(userId: string) {
    const { rows } = await this.pool.query('SELECT id, email, name FROM users WHERE id = $1', [
      userId,
    ]);
    return rows[0] || null;
  }
}
