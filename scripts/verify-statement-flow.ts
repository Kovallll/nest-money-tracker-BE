import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import * as mammoth from 'mammoth';
import { HttpService } from '@nestjs/axios';
import { GeminiProvider } from '@/ai/providers/gemini.provider';
import { GroqProvider } from '@/ai/providers/groq.provider';
import { ParseStatementInput, ParsedTransactionDraft } from '@/ai/types';

type CliArgs = {
  filePath: string;
  userId?: string;
  telegramUserId?: number;
};

type ScriptUserContext = {
  userId: string;
  primaryCardId: number;
  cards: Array<{
    id: number;
    name: string;
    currencyCode: string;
    cardType?: string;
    bankName?: string;
    cardNumber?: string;
  }>;
  categories: Array<{ id: string; title: string; icon: string; color: string }>;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { filePath: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--file' && argv[i + 1]) {
      out.filePath = argv[++i];
      continue;
    }
    if (a === '--user-id' && argv[i + 1]) {
      out.userId = argv[++i];
      continue;
    }
    if (a === '--telegram-id' && argv[i + 1]) {
      out.telegramUserId = Number(argv[++i]);
      continue;
    }
    if (!a.startsWith('--') && !out.filePath) {
      out.filePath = a;
    }
  }
  if (!out.filePath) {
    throw new Error(
      [
        'Не указан путь к файлу выписки.',
        'Пример:',
        '  yarn verify:statement --file "C:\\path\\statement.pdf" --user-id <uuid>',
        '  yarn verify:statement "C:\\path\\statement.pdf" --telegram-id 123456789',
      ].join('\n'),
    );
  }
  return out;
}

function loadDotEnvIfPresent(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  const fileVars = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx <= 0) continue;
    const key = t.slice(0, idx).trim();
    let value = t.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Last value in file wins (for duplicate keys in .env itself).
    fileVars.set(key, value);
  }
  for (const [k, v] of fileVars.entries()) {
    // Keep externally provided env (shell/CI) as higher priority.
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

function createPoolFromDatabaseUrl(): Pool {
  const raw = String(process.env.DATABASE_URL || '').trim();
  if (!raw) {
    throw new Error('DATABASE_URL не задан в окружении/.env');
  }
  const dbUrl = new URL(raw);
  const sslMode = (dbUrl.searchParams.get('sslmode') || '').toLowerCase();
  const useSsl =
    process.env.DATABASE_SSL === 'false'
      ? false
      : process.env.DATABASE_SSL === 'true' || ['require', 'verify-full', 'verify-ca'].includes(sslMode);

  return new Pool({
    host: dbUrl.hostname,
    port: Number.parseInt(dbUrl.port || '5432', 10),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.replace('/', ''),
    max: 5,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);

  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    try {
      const t = await parser.getText();
      return String(t.text || '').trim();
    } finally {
      await parser.destroy();
    }
  }

  if (ext === '.docx') {
    const out = await mammoth.extractRawText({ buffer: buf });
    return String(out.value || '').trim();
  }

  if (ext === '.txt') {
    return buf.toString('utf8').trim();
  }

  throw new Error(`Неподдерживаемый формат: ${ext}. Используйте .pdf, .docx или .txt`);
}

async function getUserContext(pool: Pool, args: CliArgs): Promise<ScriptUserContext> {
  let userId = args.userId;
  if (!userId && Number.isFinite(args.telegramUserId)) {
    const byTg = await pool.query(
      `SELECT user_id::text AS user_id
       FROM user_telegram
       WHERE telegram_user_id = $1
       ORDER BY linked_at DESC
       LIMIT 1`,
      [args.telegramUserId],
    );
    userId = byTg.rows[0]?.user_id ? String(byTg.rows[0].user_id) : undefined;
  }

  if (!userId) {
    const fallback = await pool.query(
      `SELECT user_id::text AS user_id FROM user_telegram ORDER BY linked_at DESC LIMIT 1`,
    );
    userId = fallback.rows[0]?.user_id ? String(fallback.rows[0].user_id) : undefined;
    if (userId) {
      console.warn(`--user-id/--telegram-id не передан, взят последний связанный user_id=${userId}`);
    }
  }

  if (!userId) {
    throw new Error('Не удалось определить пользователя. Передайте --user-id или --telegram-id.');
  }

  const cardsRes = await pool.query(
    `SELECT
       c.id,
       c.card_name AS name,
       c.currency_code,
       c.card_type,
       c.bank_name,
       c.card_number,
       c.is_primary
     FROM cards c
     WHERE c.user_id = $1::uuid AND c.is_active = true
     ORDER BY c.is_primary DESC, c.created_at ASC`,
    [userId],
  );
  const cards = cardsRes.rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name || ''),
    currencyCode: String(r.currency_code || 'BYN'),
    cardType: r.card_type ? String(r.card_type) : undefined,
    bankName: r.bank_name ? String(r.bank_name) : undefined,
    cardNumber: r.card_number ? String(r.card_number) : undefined,
    isPrimary: Boolean(r.is_primary),
  }));
  if (!cards.length) {
    throw new Error(`У пользователя ${userId} нет активных карт.`);
  }
  const primaryCardId = Number(cards[0].id);

  const categoriesRes = await pool.query(
    `SELECT id::text AS id, name AS title, COALESCE(icon, 'category') AS icon, COALESCE(color, '#9CA3AF') AS color
     FROM categories
     WHERE user_id = $1::uuid
     ORDER BY name ASC`,
    [userId],
  );
  const categories = categoriesRes.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    icon: String(r.icon || 'category'),
    color: String(r.color || '#9CA3AF'),
  }));
  if (!categories.length) {
    throw new Error(`У пользователя ${userId} нет категорий.`);
  }

  return { userId, primaryCardId, cards, categories };
}

function normalizeDateForInput(sourceText: string, candidateDate: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const looksLikeIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(String(candidateDate || ''));
  const inputHasDateHint =
    /\b\d{4}-\d{2}-\d{2}\b/.test(sourceText) ||
    /\b\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?\b/.test(sourceText);

  if (!inputHasDateHint) return today;
  return looksLikeIsoDate ? candidateDate : today;
}

function formatBatchPreviewBody(
  categories: Array<{ id: string; title: string }>,
  items: ParsedTransactionDraft[],
): string {
  const lines = items.map((tx, i) => {
    const catTitle =
      tx.type === 'transfer'
        ? 'Перевод'
        : categories.find((c) => c.id === tx.categoryId)?.title || '—';
    const title = String(tx.title || '').slice(0, 44);
    return `${i + 1}. ${title} — ${tx.amount} ${tx.currencyCode} | ${tx.type} | ${tx.date} | ${catTitle}`;
  });
  return `Выписка: ${items.length} операций. Проверьте список:\n${lines.join('\n')}`;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  loadDotEnvIfPresent(path.join(root, '.env'));

  const args = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(args.filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Файл не найден: ${filePath}`);
  }

  const sourceText = await extractText(filePath);
  if (!sourceText) {
    throw new Error('В файле не найден текст для разбора.');
  }

  const pool = createPoolFromDatabaseUrl();
  try {
    const userCtx = await getUserContext(pool, args);
    const fallbackCategoryId = userCtx.categories[0]?.id || '';
    if (!fallbackCategoryId) throw new Error('Не найдены категории пользователя.');

    const providerName = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
    const http = new HttpService();
    const provider =
      providerName === 'groq' ? new GroqProvider(http) : new GeminiProvider(http);

    console.log(`AI_PROVIDER=${providerName}`);
    if (providerName === 'groq') {
      console.log(`GROQ_MODEL=${process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'}`);
    } else {
      console.log('GEMINI_MODEL=gemini-2.5-flash');
    }
    console.log(`Файл: ${filePath}`);
    console.log(`Длина извлечённого текста: ${sourceText.length}`);
    console.log(`Пользователь: ${userCtx.userId}`);
    console.log('---');

    const parsedAll = await provider.parseStatementLines({
      sourceText,
      context: {
        userId: userCtx.userId,
        primaryCardId: userCtx.primaryCardId,
        cards: userCtx.cards.map((c) => ({ id: c.id, name: c.name, currencyCode: c.currencyCode })),
        categories: userCtx.categories.map((c) => ({ id: c.id, title: c.title })),
        fallbackCategoryId,
      },
      onStatementChunkProgress: ({ current, total }) => {
        console.log(`Chunk ${current}/${total}`);
      },
    } as ParseStatementInput);

    const capped = parsedAll.slice(0, 250).map((p) => ({
      ...p,
      date: normalizeDateForInput(sourceText, p.date),
    }));

    console.log(`Извлечено операций: ${parsedAll.length} (после лимита: ${capped.length})`);
    console.log('--- PREVIEW ---');
    console.log(formatBatchPreviewBody(userCtx.categories, capped));
    console.log('--- JSON ---');
    console.log(JSON.stringify(capped, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Ошибка verify:statement:', e?.message || e);
  process.exit(1);
});

