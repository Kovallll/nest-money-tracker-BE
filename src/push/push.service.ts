// api/src/push/push.service.ts
import { AiOrchestratorService } from '@/ai/ai-orchestrator.service';
import { DailyActivitySummaryInput } from '@/ai/types';
import { PG_POOL } from '@/pg/pg.module';
import { Cron } from '@nestjs/schedule';
import { Injectable, Inject, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import * as webPush from 'web-push';

const MORNING_NOTIFICATION_TYPE = 'morning_summary';
const MORNING_HOUR = 8;
const MORNING_WINDOW_MINUTES = 10;

type TimezoneClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function formatClockDate(clock: TimezoneClock): string {
  return `${clock.year.toString().padStart(4, '0')}-${clock.month.toString().padStart(2, '0')}-${clock.day.toString().padStart(2, '0')}`;
}

export function getClockInTimezone(date: Date, timeZone: string): TimezoneClock {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

export function shouldSendMorningSummaryNow(
  date: Date,
  timeZone: string,
  targetHour = MORNING_HOUR,
  windowMinutes = MORNING_WINDOW_MINUTES,
): boolean {
  const clock = getClockInTimezone(date, timeZone);
  return clock.hour === targetHour && clock.minute >= 0 && clock.minute < windowMinutes;
}

export function previousDay(localDate: string): string {
  const d = new Date(`${localDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly pushConfigured: boolean;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ai: AiOrchestratorService,
  ) {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    this.pushConfigured = Boolean(publicKey && privateKey);

    if (!this.pushConfigured) {
      this.logger.warn('VAPID keys are not set; web push is disabled.');
      return;
    }

    webPush.setVapidDetails('mailto:admin@financeapp.com', publicKey!, privateKey!);
  }

  getVapidPublicKey(): { publicKey: string } {
    return { publicKey: process.env.VAPID_PUBLIC_KEY ?? '' };
  }

  private normalizeTimezone(raw?: string): string {
    const tz = String(raw ?? '').trim();
    if (!tz) return 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
      return tz;
    } catch {
      return 'UTC';
    }
  }

  async getStatus(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT push_enabled, push_subscription, push_timezone FROM users WHERE id = $1',
      [userId],
    );

    const user = rows[0];
    return {
      pushEnabled: user?.push_enabled || false,
      hasSubscription: !!user?.push_subscription,
      timezone: user?.push_timezone ?? 'UTC',
    };
  }

  async saveSubscription(userId: string, subscription: any, userAgent: string, timezone?: string) {
    const normalizedTimezone = this.normalizeTimezone(timezone);
    await this.pool.query(
      `UPDATE users 
       SET push_subscription = $1, 
           push_enabled = true, 
           last_login = NOW(),
           user_agent = $2,
           push_timezone = $3
       WHERE id = $4`,
      [JSON.stringify(subscription), userAgent, normalizedTimezone, userId],
    );

    await this.sendToUser(userId, {
      title: 'Уведомления включены',
      body: 'Будем присылать утреннюю сводку в 08:00 по вашему времени.',
    });

    return { success: true };
  }

  async removeSubscription(userId: string) {
    await this.pool.query('UPDATE users SET push_enabled = false WHERE id = $1', [userId]);
    return { success: true };
  }

  async sendToUser(userId: string, payload: { title: string; body: string; url?: string }) {
    if (!this.pushConfigured) {
      return { sent: false, reason: 'Push service is not configured' };
    }

    const { rows } = await this.pool.query(
      'SELECT push_subscription, push_enabled FROM users WHERE id = $1',
      [userId],
    );

    const user = rows[0];
    if (!user?.push_subscription || !user.push_enabled) {
      return { sent: false, reason: 'No subscription' };
    }

    try {
      await webPush.sendNotification(
        user.push_subscription,
        JSON.stringify({
          notification: {
            title: payload.title,
            body: payload.body,
            icon: '/assets/icons/icon-192x192.png',
            badge: '/assets/icons/icon-72x72.png',
            data: { url: payload.url || '/' },
            actions: [
              { action: 'open', title: 'Открыть' },
              { action: 'close', title: 'Закрыть' },
            ],
          },
        }),
      );

      return { sent: true };
    } catch (error: any) {
      if (error.statusCode === 410) {
        await this.removeSubscription(userId);
      }
      return { sent: false, error: error.message };
    }
  }

  async sendToAll(payload: { title: string; body: string }) {
    const { rows: users } = await this.pool.query(
      `SELECT id, push_subscription 
       FROM users 
       WHERE push_enabled = true 
         AND push_subscription IS NOT NULL`,
    );

    const results = await Promise.all(users.map((u) => this.sendToUser(u.id, payload)));

    return {
      total: users.length,
      sent: results.filter((r) => r.sent).length,
      failed: results.filter((r) => !r.sent).length,
    };
  }

  async notifyNewTransaction(userId: string, transaction: any) {
    return this.sendToUser(userId, {
      title: 'Новая транзакция',
      body: `${transaction.type === 'expense' ? 'Расход' : 'Доход'}: ${transaction.amount} ₽ — ${transaction.title}`,
      url: '/transactions',
    });
  }

  @Cron('*/5 * * * *')
  async sendMorningDailySummaries(): Promise<void> {
    if (!this.pushConfigured) return;

    const now = new Date();
    const { rows: users } = await this.pool.query(
      `SELECT id, name, push_timezone
       FROM users
       WHERE push_enabled = true
         AND push_subscription IS NOT NULL`,
    );

    for (const u of users as Array<{ id: string; name: string | null; push_timezone: string | null }>) {
      const timezone = this.normalizeTimezone(u.push_timezone ?? 'UTC');
      if (!shouldSendMorningSummaryNow(now, timezone)) continue;

      const localDate = formatClockDate(getClockInTimezone(now, timezone));
      const canSend = await this.reserveDailyNotificationSlot(u.id, localDate, timezone);
      if (!canSend) continue;

      const yesterdayDate = previousDay(localDate);
      const summaryInput = await this.buildDailySummaryInput(
        u.id,
        u.name ?? undefined,
        timezone,
        localDate,
        yesterdayDate,
      );
      const aiText = await this.generateSummaryText(summaryInput);
      const sent = await this.sendToUser(u.id, {
        title: aiText.title,
        body: aiText.body,
        url: '/dashboard',
      });

      if (!sent.sent) {
        await this.rollbackDailyNotificationReservation(u.id, localDate);
        this.logger.warn(
          `Morning summary push failed for user=${u.id}, date=${localDate}, reason=${sent.reason ?? sent.error ?? 'unknown'}`,
        );
        continue;
      }

      await this.updateDailyNotificationPayload(u.id, localDate, {
        title: aiText.title,
        body: aiText.body,
      });
    }
  }

  private async reserveDailyNotificationSlot(
    userId: string,
    localDate: string,
    timezone: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO push_daily_logs (user_id, notification_type, local_date, timezone)
       VALUES ($1, $2, $3::date, $4)
       ON CONFLICT (user_id, notification_type, local_date) DO NOTHING
       RETURNING id`,
      [userId, MORNING_NOTIFICATION_TYPE, localDate, timezone],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async rollbackDailyNotificationReservation(userId: string, localDate: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM push_daily_logs
       WHERE user_id = $1
         AND notification_type = $2
         AND local_date = $3::date`,
      [userId, MORNING_NOTIFICATION_TYPE, localDate],
    );
  }

  private async updateDailyNotificationPayload(
    userId: string,
    localDate: string,
    payload: { title: string; body: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE push_daily_logs
       SET payload = $4::jsonb, sent_at = NOW()
       WHERE user_id = $1
         AND notification_type = $2
         AND local_date = $3::date`,
      [userId, MORNING_NOTIFICATION_TYPE, localDate, JSON.stringify(payload)],
    );
  }

  private async buildDailySummaryInput(
    userId: string,
    userName: string | undefined,
    timezone: string,
    localDate: string,
    yesterdayDate: string,
  ): Promise<DailyActivitySummaryInput> {
    const [{ rows: txRows }, { rows: cardRows }] = await Promise.all([
      this.pool.query(
        `SELECT
           COUNT(*)::int AS transactions_count,
           COUNT(*) FILTER (WHERE type = 'expense')::int AS expenses_count,
           COUNT(*) FILTER (WHERE type = 'revenue')::int AS revenues_count,
           COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0)::numeric AS expenses_total,
           COALESCE(SUM(CASE WHEN type = 'revenue' THEN amount END), 0)::numeric AS revenues_total
         FROM transactions
         WHERE user_id = $1
           AND date = $2::date`,
        [userId, yesterdayDate],
      ),
      this.pool.query(
        `SELECT card_name, currency_code, card_balance
         FROM cards
         WHERE user_id = $1
           AND is_active = true
         ORDER BY is_primary DESC, created_at ASC
         LIMIT 1`,
        [userId],
      ),
    ]);

    const tx = txRows[0] as {
      transactions_count: number;
      expenses_count: number;
      revenues_count: number;
      expenses_total: string;
      revenues_total: string;
    };
    const primaryCard = cardRows[0] as
      | { card_name: string; currency_code: string; card_balance: string }
      | undefined;

    return {
      userId,
      userName,
      timezone,
      localDate,
      yesterdayDate,
      transactionsCount: Number(tx?.transactions_count ?? 0),
      expensesCount: Number(tx?.expenses_count ?? 0),
      expensesTotal: Number(tx?.expenses_total ?? 0),
      revenuesCount: Number(tx?.revenues_count ?? 0),
      revenuesTotal: Number(tx?.revenues_total ?? 0),
      primaryCardName: primaryCard?.card_name,
      primaryCardCurrency: primaryCard?.currency_code ?? 'BYN',
      primaryCardBalance: primaryCard?.card_balance != null ? Number(primaryCard.card_balance) : undefined,
    };
  }

  private async generateSummaryText(
    input: DailyActivitySummaryInput,
  ): Promise<{ title: string; body: string }> {
    try {
      return await this.ai.generateDailyActivitySummary(input);
    } catch (error) {
      this.logger.warn(
        `AI daily summary failed (user=${input.userName ?? input.userId}, date=${input.localDate}): ${(error as Error).message}`,
      );
      if (input.transactionsCount === 0) {
        return {
          title: 'Утренний обзор',
          body: `Вчера транзакций не было. Добавьте новые операции сегодня, чтобы статистика была точной. Хорошего дня!`,
        };
      }
      const balance =
        input.primaryCardBalance != null
          ? `${input.primaryCardBalance.toFixed(2)} ${input.primaryCardCurrency ?? ''}`.trim()
          : 'н/д';
      return {
        title: 'Утренний обзор',
        body: `Вчера: ${input.transactionsCount} транзакций, расходов ${input.expensesTotal.toFixed(2)}, доходов ${input.revenuesTotal.toFixed(2)}. Текущий баланс: ${balance}. Хорошего дня!`,
      };
    }
  }
}
