import { PushService, previousDay, shouldSendMorningSummaryNow } from './push.service';

describe('PushService time helpers', () => {
  it('detects morning window in timezone', () => {
    // 2026-01-01T05:05:00Z == 08:05 in Europe/Minsk (UTC+3)
    const date = new Date('2026-01-01T05:05:00.000Z');
    expect(shouldSendMorningSummaryNow(date, 'Europe/Minsk', 8, 10)).toBe(true);
  });

  it('returns false outside morning window', () => {
    const date = new Date('2026-01-01T05:25:00.000Z');
    expect(shouldSendMorningSummaryNow(date, 'Europe/Minsk', 8, 10)).toBe(false);
  });

  it('calculates previous local date', () => {
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});

describe('PushService fallback daily summary', () => {
  const baseInput = {
    userId: 'u-1',
    userName: 'Test',
    timezone: 'Europe/Minsk',
    localDate: '2026-01-01',
    yesterdayDate: '2025-12-31',
    transactionsCount: 0,
    expensesCount: 0,
    expensesTotal: 0,
    revenuesCount: 0,
    revenuesTotal: 0,
    primaryCardCurrency: 'BYN',
  };

  function createService() {
    const pool = { query: jest.fn() };
    const ai = {
      generateDailyActivitySummary: jest.fn().mockRejectedValue(new Error('AI down')),
    };
    return {
      service: new PushService(pool as any, ai as any),
      ai,
    };
  }

  it('returns prompt to add transactions when none were added', async () => {
    const { service } = createService();
    const result = await (service as any).generateSummaryText({
      ...baseInput,
      transactionsCount: 0,
    });
    expect(result.title).toBe('Утренний обзор');
    expect(result.body).toContain('транзакций не было');
  });

  it('returns numeric fallback when transactions exist', async () => {
    const { service } = createService();
    const result = await (service as any).generateSummaryText({
      ...baseInput,
      transactionsCount: 3,
      expensesTotal: 45.5,
      revenuesTotal: 10,
      primaryCardBalance: 120.25,
    });
    expect(result.title).toBe('Утренний обзор');
    expect(result.body).toContain('3 транзакций');
    expect(result.body).toContain('120.25');
  });
});
