import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';
import { AiInsightItem, ChatReference, ChatResponse, InsightType } from '@/ai-insights/types';
import { ExchangeRatesService } from '@/common/exchange-rates.service';
import { Cron } from '@nestjs/schedule';
import { AiOrchestratorService } from '@/ai/ai-orchestrator.service';

type InsightRow = {
  id: string;
  user_id: string;
  type: InsightType;
  severity: 'low' | 'medium' | 'high';
  status: 'active' | 'acknowledged' | 'dismissed' | 'expired';
  title: string;
  message: string;
  confidence: string | number;
  risk_level: 'low' | 'medium' | 'high';
  source: 'rules' | 'llm' | 'market';
  payload: Record<string, unknown> | null;
  not_financial_advice: boolean;
  created_at: Date | string;
  expires_at: Date | string | null;
};

@Injectable()
export class AiInsightsService implements OnModuleInit {
  private readonly logger = new Logger(AiInsightsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly exchangeRates: ExchangeRatesService,
    private readonly ai: AiOrchestratorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ai_insights (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         type TEXT NOT NULL,
         severity TEXT NOT NULL DEFAULT 'low',
         status TEXT NOT NULL DEFAULT 'active',
         title TEXT NOT NULL,
         message TEXT NOT NULL,
         confidence NUMERIC(4,3) NOT NULL DEFAULT 0.5,
         risk_level TEXT NOT NULL DEFAULT 'low',
         source TEXT NOT NULL DEFAULT 'rules',
         payload JSONB NOT NULL DEFAULT '{}'::jsonb,
         not_financial_advice BOOLEAN NOT NULL DEFAULT false,
         dedupe_key TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         expires_at TIMESTAMPTZ
       )`,
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_user_dedupe_idx
         ON ai_insights(user_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL`,
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_user_dedupe_full_idx
         ON ai_insights(user_id, dedupe_key)`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ai_chat_sessions (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         channel TEXT NOT NULL DEFAULT 'app',
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ai_chat_messages (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         session_id UUID NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
         role TEXT NOT NULL,
         message TEXT NOT NULL,
         refs JSONB NOT NULL DEFAULT '[]'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ai_jobs_log (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID REFERENCES users(id) ON DELETE CASCADE,
         job_type TEXT NOT NULL,
         status TEXT NOT NULL,
         details JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await this.pool.query(
      `ALTER TABLE users
         ADD COLUMN IF NOT EXISTS ai_chat_enabled BOOLEAN NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS ai_insights_enabled BOOLEAN NOT NULL DEFAULT true,
         ADD COLUMN IF NOT EXISTS market_signals_enabled BOOLEAN NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS ai_beta_enabled BOOLEAN NOT NULL DEFAULT false`,
    );
  }

  async getInsights(
    userId: string,
    filter?: { status?: string; type?: string },
  ): Promise<AiInsightItem[]> {
    const flags = await this.getUserAiFlags(userId);
    if (!flags.aiInsightsEnabled) return [];

    const clauses = ['user_id = $1'];
    const params: unknown[] = [userId];
    if (filter?.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filter?.type) {
      params.push(filter.type);
      clauses.push(`type = $${params.length}`);
    }
    const { rows } = await this.pool.query<InsightRow>(
      `SELECT * FROM ai_insights
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 200`,
      params,
    );
    return rows.map((r) => this.mapRow(r));
  }

  async acknowledgeInsight(
    userId: string,
    insightId: string,
    status: 'acknowledged' | 'dismissed',
  ): Promise<{ success: boolean }> {
    const res = await this.pool.query(
      `UPDATE ai_insights
         SET status = $3
       WHERE id = $1 AND user_id = $2`,
      [insightId, userId, status],
    );
    return { success: (res.rowCount ?? 0) > 0 };
  }

  async recomputeUserInsights(userId: string, reason = 'manual'): Promise<{ created: number }> {
    const flags = await this.getUserAiFlags(userId);
    if (!flags.aiInsightsEnabled) return { created: 0 };

    const jobStart = await this.logJob(userId, 'recompute_insights', 'started', { reason });
    const computed: Array<{
      type: InsightType;
      severity: 'low' | 'medium' | 'high';
      confidence: number;
      riskLevel: 'low' | 'medium' | 'high';
      source: 'rules' | 'market';
      title: string;
      message: string;
      dedupeKey: string;
      payload?: Record<string, unknown>;
      notFinancialAdvice?: boolean;
      expiresAt?: string | null;
    }> = [];

    computed.push(...(await this.detectOverspendByCategory(userId)));
    computed.push(...(await this.detectLargeSingleTransactions(userId)));
    computed.push(...(await this.buildBudgetTips(userId)));
    if (flags.marketSignalsEnabled) {
      computed.push(...(await this.buildMarketSignals(userId)));
    }

    await this.pool.query(`UPDATE ai_insights SET status = 'expired' WHERE user_id = $1 AND status = 'active'`, [
      userId,
    ]);

    let created = 0;
    for (const item of computed) {
      const res = await this.pool.query(
        `INSERT INTO ai_insights (
           user_id, type, severity, status, title, message, confidence, risk_level, source, payload,
           not_financial_advice, dedupe_key, expires_at
         ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         ON CONFLICT (user_id, dedupe_key)
         DO UPDATE SET
           severity = EXCLUDED.severity,
           status = 'active',
           title = EXCLUDED.title,
           message = EXCLUDED.message,
           confidence = EXCLUDED.confidence,
           risk_level = EXCLUDED.risk_level,
           source = EXCLUDED.source,
           payload = EXCLUDED.payload,
           not_financial_advice = EXCLUDED.not_financial_advice,
           created_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
        [
          userId,
          item.type,
          item.severity,
          item.title,
          item.message,
          item.confidence,
          item.riskLevel,
          item.source,
          JSON.stringify(item.payload ?? {}),
          item.notFinancialAdvice === true,
          item.dedupeKey,
          item.expiresAt ?? null,
        ],
      );
      if ((res.rowCount ?? 0) > 0) created += 1;
    }

    await this.logJob(userId, 'recompute_insights', 'done', { reason, created, startedJobId: jobStart });
    return { created };
  }

  async ask(userId: string, question: string, channel: 'app' | 'telegram' = 'app'): Promise<ChatResponse> {
    const flags = await this.getUserAiFlags(userId);
    if (!flags.aiChatEnabled) {
      return {
        answer: 'AI-чат отключен в настройках профиля. Включите ai_chat_enabled, чтобы задавать вопросы.',
        references: [],
        usedFallback: true,
      };
    }

    const sessionId = await this.ensureSession(userId, channel);
    await this.appendMessage(sessionId, 'user', question, []);

    const normalized = question.toLowerCase();
    const activeInsights = await this.getInsights(userId, { status: 'active' });
    const refs: ChatReference[] = activeInsights.slice(0, 3).map((x) => ({
      kind: 'insight',
      value: `${x.type}:${x.title}`,
    }));

    const financeContext = await this.getFullUserFinanceContext(userId);
    const totals = {
      monthExpenses: financeContext.monthExpenses,
      monthRevenues: financeContext.monthRevenues,
    };
    const topCategories = financeContext.topExpenseCategories ?? [];
    refs.push(
      { kind: 'metric', value: `monthExpenses=${totals.monthExpenses.toFixed(2)}` },
      { kind: 'metric', value: `monthRevenues=${totals.monthRevenues.toFixed(2)}` },
    );
    for (const c of topCategories.slice(0, 3)) {
      refs.push({ kind: 'metric', value: `topCategory:${c.category}:${c.total.toFixed(2)}` });
    }

    const normalizedCompact = normalized.replace(/\s+/g, ' ');
    const period = this.extractPeriodRange(normalizedCompact);

    const asksTopTransactions =
      normalizedCompact.includes('топ') &&
      (normalizedCompact.includes('транзак') ||
        normalizedCompact.includes('покуп') ||
        normalizedCompact.includes('чек'));
    if (asksTopTransactions) {
      const topTx = await this.getTopExpenseTransactions(userId, period.startDate, 3);
      if (!topTx.length) {
        const noDataAnswer = `За период "${period.label}" нет расходных транзакций, поэтому топ сформировать нельзя.`;
        await this.appendMessage(sessionId, 'assistant', noDataAnswer, refs);
        return { answer: noDataAnswer, references: refs, usedFallback: false };
      }
      const answer = [
        `Топ расходов за ${period.label}:`,
        ...topTx.map(
          (t, i) =>
            `${i + 1}) ${t.amount.toFixed(2)} ${t.currencyCode} — ${t.title || 'Без названия'} (${t.date}, ${
              t.categoryName
            })`,
        ),
      ].join('\n');
      await this.appendMessage(sessionId, 'assistant', answer, refs);
      return { answer, references: refs, usedFallback: false };
    }

    const asksSubscriptionsImpact =
      normalizedCompact.includes('подписк') &&
      (normalizedCompact.includes('влияет') ||
        normalizedCompact.includes('влияни') ||
        normalizedCompact.includes('в месяц') ||
        normalizedCompact.includes('сколько'));
    if (asksSubscriptionsImpact) {
      const subs = await this.getActiveSubscriptionsImpact(userId);
      if (subs.count === 0) {
        const answer = 'Сейчас у вас нет активных подписок, которые регулярно расходуют бюджет.';
        await this.appendMessage(sessionId, 'assistant', answer, refs);
        return { answer, references: refs, usedFallback: false };
      }
      const share =
        totals.monthExpenses > 0 ? Math.min(100, (subs.monthlyTotal / totals.monthExpenses) * 100) : 0;
      const answer = `Активных подписок: ${subs.count}. Их суммарная регулярная нагрузка ~${subs.monthlyTotal.toFixed(
        2,
      )} в месяц (${share.toFixed(1)}% от ваших расходов за текущий месяц).`;
      await this.appendMessage(sessionId, 'assistant', answer, refs);
      return { answer, references: refs, usedFallback: false };
    }
    const asksTopCategory =
      (normalizedCompact.includes('категор') &&
        (normalizedCompact.includes('больше всего') ||
          normalizedCompact.includes('больше') ||
          normalizedCompact.includes('топ') ||
          normalizedCompact.includes('наибольш'))) ||
      normalizedCompact.includes('куда больше всего уходит') ||
      normalizedCompact.includes('основная статья расход');
    if (asksTopCategory) {
      const topByPeriod = await this.getTopExpenseCategoriesByPeriod(userId, period.startDate, 3);
      if (!topByPeriod.length) {
        const noDataAnswer = `За период "${period.label}" нет расходов по категориям, поэтому топ-категорию определить нельзя.`;
        await this.appendMessage(sessionId, 'assistant', noDataAnswer, refs);
        return { answer: noDataAnswer, references: refs, usedFallback: false };
      }
      const top = topByPeriod[0];
      const answer = `Больше всего средств за ${period.label} уходит в категорию "${top.category}" — ${top.total.toFixed(
        2,
      )}. Далее: ${topByPeriod
        .slice(1, 3)
        .map((x) => `"${x.category}" ${x.total.toFixed(2)}`)
        .join(', ')}.`;
      await this.appendMessage(sessionId, 'assistant', answer, refs);
      return { answer, references: refs, usedFallback: false };
    }

    let answer = '';
    let usedFallback = false;
    try {
      const rates = this.exchangeRates.getRateToByn();
      const aiResponse = await this.ai.answerFinanceQuestion({
        question,
        userContext: {
          ...financeContext,
          activeInsights: activeInsights.slice(0, 5).map((x) => ({
            type: x.type,
            title: x.title,
            message: x.message,
            severity: x.severity,
            confidence: x.confidence,
          })),
          ratesToByn: rates,
        },
      });
      if (aiResponse.isFinanceTopic) {
        answer = aiResponse.disclaimer
          ? `${aiResponse.answer}\n\n${aiResponse.disclaimer}`
          : aiResponse.answer;
      } else {
        answer =
          'Я отвечаю на финансовые темы: личный бюджет, траты, доходы, кредиты, инвестиции, валюты и экономику.';
      }
    } catch (err) {
      this.logger.warn(`AI finance answer failed, using fallback: ${(err as Error).message}`);
      usedFallback = true;
    }

    if (!answer && (normalized.includes('аномал') || normalized.includes('подозр'))) {
      const anomalies = activeInsights.filter((i) => i.type === 'anomaly' || i.type === 'overspend');
      answer = anomalies.length
        ? `Нашел ${anomalies.length} потенциальных отклонений. Самые важные: ${anomalies
            .slice(0, 2)
            .map((x) => x.title)
            .join('; ')}. Рекомендую проверить эти категории и поставить лимит на месяц.`
        : `Я не вижу выраженных аномалий за последние данные. Чтобы повысить точность, добавляйте транзакции регулярно и с точными категориями.`;
      usedFallback = true;
    } else if (
      !answer &&
      (normalized.includes('курс') ||
        normalized.includes('доллар') ||
        normalized.includes('валют'))
    ) {
      const rates = this.exchangeRates.getRateToByn();
      answer = `Текущие ориентиры: USD ${Number(rates.USD ?? 0).toFixed(4)} BYN, EUR ${Number(
        rates.EUR ?? 0,
      ).toFixed(4)} BYN. Это не инвестиционная рекомендация; лучше дробить покупку валюты на 2-3 этапа, чтобы снизить риск входа в пик.`;
      usedFallback = true;
    } else if (!answer && (normalized.includes('сэконом') || normalized.includes('эконом'))) {
      answer = `За текущий месяц расходы ${totals.monthExpenses.toFixed(2)}, доходы ${totals.monthRevenues.toFixed(
        2,
      )}. Начните с категории с самым быстрым ростом: сократите ее на 10-15% и включите недельный лимит с пуш-напоминанием.`;
      usedFallback = true;
    } else if (!answer) {
      answer = `Я могу помочь с анализом расходов, аномалиями, лимитами, курсами валют и базовыми инвестиционными рисками. Спросите, например: "где у меня перерасход?", "что с курсом доллара?" или "как сократить траты на еду?".`;
      usedFallback = true;
    }

    await this.appendMessage(sessionId, 'assistant', answer, refs);
    return { answer, references: refs, usedFallback };
  }

  async getUserMetrics(userId: string): Promise<{
    activeInsights: number;
    acknowledgedInsights: number;
    dismissedInsights: number;
    jobsLast24h: number;
    fallbackChatRateLast24h: number;
  }> {
    const [{ rows: insightRows }, { rows: jobsRows }, { rows: chatRows }] = await Promise.all([
      this.pool.query<{ status: string; cnt: string }>(
        `SELECT status, COUNT(*)::text AS cnt
         FROM ai_insights
         WHERE user_id = $1
         GROUP BY status`,
        [userId],
      ),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM ai_jobs_log
         WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [userId],
      ),
      this.pool.query<{ total: string; fallback_like: string }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE message ILIKE '%Я могу помочь%' OR message ILIKE '%это не инвестиционная рекомендация%')::text AS fallback_like
         FROM ai_chat_messages m
         JOIN ai_chat_sessions s ON s.id = m.session_id
         WHERE s.user_id = $1
           AND m.role = 'assistant'
           AND m.created_at >= NOW() - INTERVAL '24 hours'`,
        [userId],
      ),
    ]);
    const byStatus = new Map(insightRows.map((r) => [r.status, Number(r.cnt)]));
    const chatTotal = Number(chatRows[0]?.total ?? 0);
    const fallbackLike = Number(chatRows[0]?.fallback_like ?? 0);
    return {
      activeInsights: byStatus.get('active') ?? 0,
      acknowledgedInsights: byStatus.get('acknowledged') ?? 0,
      dismissedInsights: byStatus.get('dismissed') ?? 0,
      jobsLast24h: Number(jobsRows[0]?.cnt ?? 0),
      fallbackChatRateLast24h: chatTotal > 0 ? fallbackLike / chatTotal : 0,
    };
  }

  @Cron('15 * * * *')
  async runScheduledRecompute(): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM users
       WHERE is_active = true
         AND COALESCE(ai_insights_enabled, true) = true
         AND (
           COALESCE(ai_beta_enabled, false) = true
           OR COALESCE(market_signals_enabled, false) = true
         )
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    for (const user of rows) {
      await this.recomputeUserInsights(user.id, 'scheduled').catch((err) => {
        this.logger.warn(`Scheduled recompute failed for user=${user.id}: ${(err as Error).message}`);
      });
    }
  }

  private async ensureSession(userId: string, channel: 'app' | 'telegram'): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM ai_chat_sessions
       WHERE user_id = $1 AND channel = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId, channel],
    );
    if (rows[0]?.id) {
      await this.pool.query(`UPDATE ai_chat_sessions SET updated_at = NOW() WHERE id = $1`, [rows[0].id]);
      return rows[0].id;
    }
    const created = await this.pool.query<{ id: string }>(
      `INSERT INTO ai_chat_sessions (user_id, channel) VALUES ($1, $2) RETURNING id`,
      [userId, channel],
    );
    return created.rows[0].id;
  }

  private async appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    message: string,
    references: ChatReference[],
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_chat_messages (session_id, role, message, refs)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [sessionId, role, message, JSON.stringify(references)],
    );
  }

  private async logJob(
    userId: string | null,
    jobType: string,
    status: string,
    details: Record<string, unknown>,
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO ai_jobs_log (user_id, job_type, status, details)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [userId, jobType, status, JSON.stringify(details)],
    );
    return rows[0].id;
  }

  private async getUserAiFlags(userId: string): Promise<{
    aiChatEnabled: boolean;
    aiInsightsEnabled: boolean;
    marketSignalsEnabled: boolean;
  }> {
    try {
      const { rows } = await this.pool.query<{
        ai_chat_enabled: boolean | null;
        ai_insights_enabled: boolean | null;
        market_signals_enabled: boolean | null;
      }>(
        `SELECT ai_chat_enabled, ai_insights_enabled, market_signals_enabled
         FROM users WHERE id = $1`,
        [userId],
      );
      const row = rows[0];
      return {
        aiChatEnabled: row?.ai_chat_enabled !== false,
        aiInsightsEnabled: row?.ai_insights_enabled !== false,
        marketSignalsEnabled: row?.market_signals_enabled === true,
      };
    } catch (err) {
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '42703') {
        // DB is older than code; degrade gracefully until migrations are applied.
        this.logger.warn(
          `AI flags columns are missing in users table. Falling back to defaults. ${pgErr.message ?? ''}`,
        );
        return {
          aiChatEnabled: true,
          aiInsightsEnabled: true,
          marketSignalsEnabled: false,
        };
      }
      throw err;
    }
  }

  private mapRow(r: InsightRow): AiInsightItem {
    return {
      id: r.id,
      userId: r.user_id,
      type: r.type,
      severity: r.severity,
      status: r.status,
      title: r.title,
      message: r.message,
      confidence: Number(r.confidence ?? 0.5),
      riskLevel: r.risk_level,
      source: r.source,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      notFinancialAdvice: r.not_financial_advice === true,
      createdAt: this.toIso(r.created_at),
      expiresAt: r.expires_at ? this.toIso(r.expires_at) : null,
    };
  }

  private toIso(v: Date | string): string {
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  }

  private async getQuickUserTotals(userId: string): Promise<{
    monthExpenses: number;
    monthRevenues: number;
  }> {
    const { rows } = await this.pool.query<{
      expenses: string;
      revenues: string;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0)::text AS expenses,
         COALESCE(SUM(CASE WHEN type = 'revenue' THEN amount END), 0)::text AS revenues
       FROM transactions
       WHERE user_id = $1
         AND date >= DATE_TRUNC('month', NOW())::date`,
      [userId],
    );
    return {
      monthExpenses: Number(rows[0]?.expenses ?? 0),
      monthRevenues: Number(rows[0]?.revenues ?? 0),
    };
  }

  private async getTopExpenseCategories(
    userId: string,
    limit = 5,
  ): Promise<Array<{ categoryId: string | null; category: string; total: number }>> {
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
    const { rows } = await this.pool.query<{
      category_id: string | null;
      category_name: string | null;
      total: string;
    }>(
      `SELECT
         t.category_id,
         c.name AS category_name,
         SUM(t.amount)::text AS total
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.date >= DATE_TRUNC('month', NOW())::date
       GROUP BY t.category_id, c.name
       ORDER BY SUM(t.amount) DESC
       LIMIT ${safeLimit}`,
      [userId],
    );
    return rows.map((r) => ({
      categoryId: r.category_id,
      category: r.category_name ?? 'Без категории',
      total: Number(r.total ?? 0),
    }));
  }

  private async getTopExpenseCategoriesByPeriod(
    userId: string,
    startDate: string,
    limit = 3,
  ): Promise<Array<{ categoryId: string | null; category: string; total: number }>> {
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 3));
    const { rows } = await this.pool.query<{
      category_id: string | null;
      category_name: string | null;
      total: string;
    }>(
      `SELECT
         t.category_id,
         c.name AS category_name,
         SUM(t.amount)::text AS total
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.date >= $2::date
       GROUP BY t.category_id, c.name
       ORDER BY SUM(t.amount) DESC
       LIMIT ${safeLimit}`,
      [userId, startDate],
    );
    return rows.map((r) => ({
      categoryId: r.category_id,
      category: r.category_name ?? 'Без категории',
      total: Number(r.total ?? 0),
    }));
  }

  private async getTopExpenseTransactions(
    userId: string,
    startDate: string,
    limit = 3,
  ): Promise<
    Array<{
      id: number;
      amount: number;
      currencyCode: string;
      title: string;
      date: string;
      categoryName: string;
    }>
  > {
    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 3));
    const { rows } = await this.pool.query<{
      id: number;
      amount: string;
      currency_code: string | null;
      title: string | null;
      date: Date | string;
      category_name: string | null;
    }>(
      `SELECT
         t.id,
         t.amount::text AS amount,
         t.currency_code,
         t.title,
         t.date,
         c.name AS category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.type = 'expense'
         AND t.date >= $2::date
       ORDER BY t.amount DESC
       LIMIT ${safeLimit}`,
      [userId, startDate],
    );
    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount ?? 0),
      currencyCode: r.currency_code ?? 'BYN',
      title: r.title ?? 'Без названия',
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
      categoryName: r.category_name ?? 'Без категории',
    }));
  }

  private async getActiveSubscriptionsImpact(userId: string): Promise<{ count: number; monthlyTotal: number }> {
    const { rows } = await this.pool.query<{ cnt: string; total: string }>(
      `SELECT
         COUNT(*)::text AS cnt,
         COALESCE(SUM(amount), 0)::text AS total
       FROM subscriptions
       WHERE user_id = $1
         AND group_room_id IS NULL
         AND COALESCE(is_active, true) = true`,
      [userId],
    );
    return {
      count: Number(rows[0]?.cnt ?? 0),
      monthlyTotal: Number(rows[0]?.total ?? 0),
    };
  }

  private extractPeriodRange(text: string): { label: string; startDate: string } {
    const now = new Date();
    const mk = (d: Date) => d.toISOString().slice(0, 10);
    if (text.includes('квартал') || text.includes('квартале')) {
      const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      return { label: 'последний квартал', startDate: mk(start) };
    }
    if (
      text.includes('год') ||
      text.includes('года') ||
      text.includes('за 12 месяцев') ||
      text.includes('за год')
    ) {
      const start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      return { label: 'последний год', startDate: mk(start) };
    }
    if (text.includes('недел')) {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { label: 'последнюю неделю', startDate: mk(start) };
    }
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return { label: 'текущий месяц', startDate: mk(monthStart) };
  }

  private async detectOverspendByCategory(userId: string) {
    const { rows } = await this.pool.query<{
      category_id: string | null;
      category_name: string | null;
      this_month: string;
      prev_avg: string;
    }>(
      `WITH monthly AS (
         SELECT
           t.category_id AS category_id,
           DATE_TRUNC('month', t.date)::date AS month_key,
           SUM(t.amount)::numeric AS total
         FROM transactions t
         WHERE t.user_id = $1 AND t.type = 'expense'
           AND t.date >= (DATE_TRUNC('month', NOW()) - INTERVAL '6 months')::date
         GROUP BY 1,2
       ),
       pivoted AS (
         SELECT
           m.category_id,
           SUM(m.total) FILTER (WHERE m.month_key = DATE_TRUNC('month', NOW())::date) AS this_month,
           AVG(m.total) FILTER (WHERE m.month_key < DATE_TRUNC('month', NOW())::date) AS prev_avg
         FROM monthly m
         GROUP BY m.category_id
       )
       SELECT
         p.category_id,
         c.name AS category_name,
         COALESCE(p.this_month, 0)::text AS this_month,
         COALESCE(p.prev_avg, 0)::text AS prev_avg
       FROM pivoted p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE COALESCE(p.prev_avg, 0) > 0
         AND COALESCE(p.this_month, 0) >= COALESCE(p.prev_avg, 0) * 1.35
       ORDER BY (COALESCE(p.this_month, 0) - COALESCE(p.prev_avg, 0)) DESC
       LIMIT 3`,
      [userId],
    );

    return rows.map((r) => {
      const current = Number(r.this_month);
      const avg = Number(r.prev_avg);
      const ratio = avg > 0 ? current / avg : 1;
      const category = r.category_name ?? 'Без категории';
      return {
        type: 'overspend' as const,
        severity: ratio >= 1.8 ? ('high' as const) : ('medium' as const),
        confidence: Math.min(0.95, 0.65 + Math.min(0.3, (ratio - 1) / 2)),
        riskLevel: ratio >= 1.8 ? ('high' as const) : ('medium' as const),
        source: 'rules' as const,
        title: `Перерасход в категории "${category}"`,
        message: `В этом месяце траты на "${category}" составили ${current.toFixed(
          2,
        )}, это на ${((ratio - 1) * 100).toFixed(0)}% выше вашего среднего. Стоит установить лимит и проверить крупные покупки.`,
        dedupeKey: `overspend:${r.category_id}`,
        payload: { categoryId: r.category_id, category, current, avg, ratio },
      };
    });
  }

  private async detectLargeSingleTransactions(userId: string) {
    const { rows } = await this.pool.query<{
      amount: string;
      title: string | null;
      date: Date | string;
      category_name: string | null;
      median_amount: string;
    }>(
      `WITH base AS (
         SELECT t.*, c.name AS category_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1
           AND t.type = 'expense'
           AND t.date >= (NOW()::date - INTERVAL '30 days')::date
       ),
       med AS (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS median_amount
         FROM base
       )
       SELECT b.amount::text, b.title, b.date, b.category_name, COALESCE(m.median_amount, 0)::text AS median_amount
       FROM base b
       CROSS JOIN med m
       WHERE COALESCE(m.median_amount, 0) > 0
         AND b.amount >= m.median_amount * 3
       ORDER BY b.amount DESC
       LIMIT 3`,
      [userId],
    );

    return rows.map((r, idx) => {
      const amount = Number(r.amount);
      const median = Number(r.median_amount);
      return {
        type: 'anomaly' as const,
        severity: amount >= median * 5 ? ('high' as const) : ('medium' as const),
        confidence: 0.7,
        riskLevel: amount >= median * 5 ? ('high' as const) : ('medium' as const),
        source: 'rules' as const,
        title: `Нетипично крупный расход: ${amount.toFixed(2)}`,
        message: `Транзакция "${r.title || 'Без названия'}" (${r.category_name || 'Без категории'}) заметно выше обычного чека. Проверьте, это плановая покупка или выброс.`,
        dedupeKey: `anomaly:large:${idx}:${new Date(r.date).toISOString().slice(0, 10)}`,
        payload: {
          amount,
          median,
          date: new Date(r.date).toISOString().slice(0, 10),
          title: r.title || '',
          category: r.category_name || '',
        },
      };
    });
  }

  private async buildBudgetTips(userId: string) {
    const totals = await this.getQuickUserTotals(userId);
    if (totals.monthExpenses <= 0) return [];
    const ratio = totals.monthRevenues > 0 ? totals.monthExpenses / totals.monthRevenues : 999;
    if (ratio < 0.8) return [];
    return [
      {
        type: 'budget_tip' as const,
        severity: ratio >= 1 ? ('high' as const) : ('medium' as const),
        confidence: 0.75,
        riskLevel: ratio >= 1 ? ('high' as const) : ('medium' as const),
        source: 'rules' as const,
        title: 'Расходы приблизились к доходам',
        message: `В этом месяце расходы ${totals.monthExpenses.toFixed(
          2,
        )}, доходы ${totals.monthRevenues.toFixed(
          2,
        )}. Рекомендую ограничить 1-2 discretionary категории и оставить резерв минимум 10%.`,
        dedupeKey: 'budget_tip:income_vs_expense',
        payload: totals,
      },
    ];
  }

  private async buildMarketSignals(userId: string) {
    await this.exchangeRates.loadRates().catch(() => {
      this.logger.warn('Cannot refresh rates for market signals');
    });
    const rates = this.exchangeRates.getRateToByn();
    const usd = Number(rates.USD ?? 0);
    if (!Number.isFinite(usd) || usd <= 0) return [];

    const signals: Array<{
      type: 'fx_signal' | 'investment_signal';
      severity: 'low' | 'medium' | 'high';
      confidence: number;
      riskLevel: 'low' | 'medium' | 'high';
      source: 'market';
      title: string;
      message: string;
      dedupeKey: string;
      payload: Record<string, unknown>;
      notFinancialAdvice: boolean;
      expiresAt: string;
    }> = [];

    const nowDate = new Date();
    const expires = new Date(nowDate);
    expires.setDate(expires.getDate() + 2);

    signals.push({
      type: 'fx_signal',
      severity: 'low',
      confidence: 0.55,
      riskLevel: 'medium',
      source: 'market',
      title: 'Сигнал по валюте USD/BYN',
      message: `Текущий ориентир USD ${usd.toFixed(
        4,
      )} BYN. Рассмотрите стратегию поэтапной покупки (2-3 части) вместо единовременной сделки, чтобы снизить риск волатильности.`,
      dedupeKey: `fx_signal:usd:${this.exchangeRates.getCacheDate()}`,
      payload: { pair: 'USD/BYN', usdToByn: usd, date: this.exchangeRates.getCacheDate() },
      notFinancialAdvice: true,
      expiresAt: expires.toISOString(),
    });

    signals.push({
      type: 'investment_signal',
      severity: 'low',
      confidence: 0.5,
      riskLevel: 'high',
      source: 'market',
      title: 'Инвест-напоминание о риске',
      message:
        'Перед покупкой волатильных активов (акции/ETF/крипто) проверьте размер подушки безопасности: желательно 3-6 месяцев расходов на ликвидном счете.',
      dedupeKey: `investment_signal:risk:${this.exchangeRates.getCacheDate()}`,
      payload: { recommendation: 'safety_buffer_3_6_months' },
      notFinancialAdvice: true,
      expiresAt: expires.toISOString(),
    });

    await this.logJob(userId, 'market_signals', 'done', {
      signals: signals.length,
      ratesDate: this.exchangeRates.getCacheDate(),
    });
    return signals;
  }

  private async getFullUserFinanceContext(userId: string): Promise<{
    userId: string;
    monthExpenses: number;
    monthRevenues: number;
    cards: Array<{
      id: number;
      cardName: string;
      cardBalance: number;
      currencyCode: string;
      isPrimary: boolean;
    }>;
    categories: Array<{
      id: string;
      name: string;
      monthExpenseTotal: number;
      monthTransactionsCount: number;
    }>;
    recentTransactions: Array<{
      id: number;
      type: string;
      amount: number;
      currencyCode: string;
      title: string;
      date: string;
      categoryName: string;
    }>;
    goals: Array<{
      id: string;
      title: string;
      targetBudget: number;
      goalBudget: number;
      currencyCode: string;
      status: string;
    }>;
    subscriptions: Array<{
      id: string;
      subscribeName: string;
      amount: number;
      currencyCode: string;
      subscribeDate: string;
      isActive: boolean;
    }>;
    topExpenseCategories: Array<{ categoryId: string | null; category: string; total: number }>;
  }> {
    const [
      totals,
      cardsRes,
      categoriesRes,
      txRes,
      goalsRes,
      subsRes,
      topExpenseCategories,
    ] = await Promise.all([
      this.getQuickUserTotals(userId),
      this.pool.query<{
        id: number;
        card_name: string;
        card_balance: string;
        currency_code: string | null;
        is_primary: boolean | null;
      }>(
        `SELECT id, card_name, card_balance::text AS card_balance, currency_code, is_primary
         FROM cards
         WHERE user_id = $1 AND is_active = true
         ORDER BY is_primary DESC, id ASC
         LIMIT 20`,
        [userId],
      ),
      this.pool.query<{
        id: string;
        name: string;
        month_expense_total: string;
        month_transactions_count: string;
      }>(
        `SELECT
           c.id,
           c.name,
           COALESCE(SUM(t.amount), 0)::text AS month_expense_total,
           COUNT(t.id)::text AS month_transactions_count
         FROM categories c
         LEFT JOIN transactions t
           ON t.category_id = c.id
          AND t.user_id = $1
          AND t.type = 'expense'
          AND t.date >= DATE_TRUNC('month', NOW())::date
         WHERE (c.user_id = $1 OR c.user_id IS NULL) AND c.group_room_id IS NULL
         GROUP BY c.id, c.name
         ORDER BY COALESCE(SUM(t.amount), 0) DESC, c.name ASC
         LIMIT 60`,
        [userId],
      ),
      this.pool.query<{
        id: number;
        type: string;
        amount: string;
        currency_code: string | null;
        title: string | null;
        date: Date | string;
        category_name: string | null;
      }>(
        `SELECT
           t.id,
           t.type,
           t.amount::text AS amount,
           t.currency_code,
           t.title,
           t.date,
           c.name AS category_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1
         ORDER BY t.date DESC, t.id DESC
         LIMIT 200`,
        [userId],
      ),
      this.pool.query<{
        id: string;
        title: string;
        target_budget: string;
        goal_budget: string;
        currency_code: string | null;
        status: string | null;
      }>(
        `SELECT id, title, target_budget::text AS target_budget, goal_budget::text AS goal_budget, currency_code, status
         FROM goals
         WHERE user_id = $1 AND group_room_id IS NULL
         ORDER BY created_at DESC
         LIMIT 40`,
        [userId],
      ),
      this.pool.query<{
        id: string;
        subscribe_name: string;
        amount: string;
        currency_code: string | null;
        subscribe_date: Date | string;
        is_active: boolean | null;
      }>(
        `SELECT id, subscribe_name, amount::text AS amount, currency_code, subscribe_date, is_active
         FROM subscriptions
         WHERE user_id = $1 AND group_room_id IS NULL
         ORDER BY created_at DESC
         LIMIT 60`,
        [userId],
      ),
      this.getTopExpenseCategories(userId, 10),
    ]);

    return {
      userId,
      monthExpenses: totals.monthExpenses,
      monthRevenues: totals.monthRevenues,
      cards: cardsRes.rows.map((r) => ({
        id: r.id,
        cardName: r.card_name,
        cardBalance: Number(r.card_balance ?? 0),
        currencyCode: r.currency_code ?? 'BYN',
        isPrimary: r.is_primary === true,
      })),
      categories: categoriesRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        monthExpenseTotal: Number(r.month_expense_total ?? 0),
        monthTransactionsCount: Number(r.month_transactions_count ?? 0),
      })),
      recentTransactions: txRes.rows.map((r) => ({
        id: r.id,
        type: r.type,
        amount: Number(r.amount ?? 0),
        currencyCode: r.currency_code ?? 'BYN',
        title: r.title ?? '',
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
        categoryName: r.category_name ?? 'Без категории',
      })),
      goals: goalsRes.rows.map((r) => ({
        id: r.id,
        title: r.title,
        targetBudget: Number(r.target_budget ?? 0),
        goalBudget: Number(r.goal_budget ?? 0),
        currencyCode: r.currency_code ?? 'BYN',
        status: r.status ?? 'active',
      })),
      subscriptions: subsRes.rows.map((r) => ({
        id: r.id,
        subscribeName: r.subscribe_name,
        amount: Number(r.amount ?? 0),
        currencyCode: r.currency_code ?? 'BYN',
        subscribeDate:
          r.subscribe_date instanceof Date
            ? r.subscribe_date.toISOString().slice(0, 10)
            : String(r.subscribe_date),
        isActive: r.is_active !== false,
      })),
      topExpenseCategories,
    };
  }
}

