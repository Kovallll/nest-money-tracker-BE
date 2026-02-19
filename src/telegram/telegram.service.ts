import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { Telegraf } from 'telegraf';
import { randomBytes } from 'crypto';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf | null = null;
  private botUsername: string | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'your-telegram-bot-token') {
      this.logger.warn('⚠️ TELEGRAM_BOT_TOKEN не задан — бот не запущен');
      return;
    }

    this.bot = new Telegraf(token);

    try {
      const me = await this.bot.telegram.getMe();
      this.botUsername = me.username ?? null;
      this.logger.log(`🤖 Telegram-бот @${this.botUsername} подключён`);
    } catch (err) {
      this.logger.error(
        '❌ Не удалось получить информацию о боте — проверь TELEGRAM_BOT_TOKEN',
        err,
      );
      this.bot = null;
      return;
    }

    this.registerHandlers();
    this.bot.launch();
  }

  async onModuleDestroy(): Promise<void> {
    this.bot?.stop('app shutdown');
  }

  private registerHandlers(): void {
    if (!this.bot) return;

    this.bot.start(async (ctx) => {
      const payload = ctx.payload; // часть после /start — "lk_<код>"

      if (!payload?.startsWith('lk_')) {
        await ctx.reply(
          '👋 Привет! Чтобы привязать аккаунт, получите ссылку в приложении Finance.',
        );
        return;
      }

      const code = payload.slice(3); // убираем "lk_"
      const telegramUserId = ctx.from.id;

      try {
        const result = await this.redeemCode(code, telegramUserId);

        if (result.success) {
          await ctx.reply('✅ Аккаунт успешно привязан! Теперь вы будете получать уведомления.');
        } else {
          await ctx.reply(`❌ ${result.error}`);
        }
      } catch {
        await ctx.reply('❌ Произошла ошибка при привязке. Попробуйте ещё раз.');
      }
    });

    this.bot.catch((err) => {
      this.logger.error('Telegram bot error', err);
    });
  }

  async generateLinkCode(userId: string): Promise<{ code: string; link: string }> {
    await this.pool.query(`DELETE FROM link_codes WHERE user_id = $1 AND used_at IS NULL`, [
      userId,
    ]);

    const code = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 минут

    await this.pool.query(
      `INSERT INTO link_codes (code, user_id, expires_at) VALUES ($1, $2, $3)`,
      [code, userId, expiresAt],
    );

    if (!this.botUsername) {
      throw new Error('Telegram-бот не инициализирован');
    }

    const link = `https://t.me/${this.botUsername}?start=lk_${code}`;

    return { code, link };
  }

  async getLinkStatus(userId: string): Promise<{ linked: boolean; telegramUserId?: number }> {
    const { rows } = await this.pool.query(
      'SELECT telegram_user_id FROM user_telegram WHERE user_id = $1',
      [userId],
    );

    if (rows.length === 0) return { linked: false };
    return { linked: true, telegramUserId: Number(rows[0].telegram_user_id) };
  }

  async unlinkTelegram(userId: string): Promise<{ success: boolean }> {
    const result = await this.pool.query('DELETE FROM user_telegram WHERE user_id = $1', [userId]);
    return { success: (result.rowCount ?? 0) > 0 };
  }

  private async redeemCode(
    code: string,
    telegramUserId: number,
  ): Promise<{ success: boolean; error?: string }> {
    const { rows } = await this.pool.query(
      `SELECT user_id, expires_at, used_at FROM link_codes WHERE code = $1`,
      [code],
    );

    if (rows.length === 0) {
      return { success: false, error: 'Код не найден или недействителен.' };
    }

    const linkCode = rows[0];

    if (linkCode.used_at) {
      return { success: false, error: 'Этот код уже был использован.' };
    }

    if (new Date(linkCode.expires_at) < new Date()) {
      return { success: false, error: 'Код просрочен. Получите новый в приложении.' };
    }

    const alreadyLinked = await this.pool.query('SELECT 1 FROM user_telegram WHERE user_id = $1', [
      linkCode.user_id,
    ]);
    if ((alreadyLinked.rowCount ?? 0) > 0) {
      return { success: false, error: 'Этот аккаунт уже привязан к Telegram.' };
    }

    const tgTaken = await this.pool.query(
      'SELECT 1 FROM user_telegram WHERE telegram_user_id = $1',
      [telegramUserId],
    );
    if ((tgTaken.rowCount ?? 0) > 0) {
      return {
        success: false,
        error: 'Этот Telegram-аккаунт уже привязан к другому пользователю.',
      };
    }

    await this.pool.query(`UPDATE link_codes SET used_at = NOW() WHERE code = $1`, [code]);

    await this.pool.query(`INSERT INTO user_telegram (user_id, telegram_user_id) VALUES ($1, $2)`, [
      linkCode.user_id,
      telegramUserId,
    ]);

    return { success: true };
  }
}

