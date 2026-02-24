// api/src/push/push.service.ts
import { PG_POOL } from '@/pg/pg.module';
import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

import * as webPush from 'web-push';

@Injectable()
export class PushService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    webPush.setVapidDetails(
      'mailto:admin@financeapp.com',
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
  }

  getVapidPublicKey(): { publicKey: string } {
    return { publicKey: process.env.VAPID_PUBLIC_KEY ?? '' };
  }

  async getStatus(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT push_enabled, push_subscription FROM users WHERE id = $1',
      [userId],
    );

    const user = rows[0];
    return {
      pushEnabled: user?.push_enabled || false,
      hasSubscription: !!user?.push_subscription,
    };
  }

  async saveSubscription(userId: string, subscription: any, userAgent: string) {
    await this.pool.query(
      `UPDATE users 
       SET push_subscription = $1, 
           push_enabled = true, 
           last_login = NOW(),
           user_agent = $2
       WHERE id = $3`,
      [JSON.stringify(subscription), userAgent, userId],
    );

    // Приветственное уведомление
    await this.sendToUser(userId, {
      title: '🔔 Уведомления включены',
      body: 'Теперь вы будете получать уведомления о транзакциях',
    });

    return { success: true };
  }

  async removeSubscription(userId: string) {
    await this.pool.query('UPDATE users SET push_enabled = false WHERE id = $1', [userId]);
    return { success: true };
  }

  async sendToUser(userId: string, payload: { title: string; body: string; url?: string }) {
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
      title: '💰 Новая транзакция',
      body: `${transaction.type === 'expense' ? 'Расход' : 'Доход'}: ${transaction.amount} ₽ — ${transaction.title}`,
      url: '/transactions',
    });
  }
}
