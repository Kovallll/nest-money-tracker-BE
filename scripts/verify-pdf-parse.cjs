/**
 * Локальная проверка: pdf-parse v2 (как в Telegram) извлекает текст из PDF.
 *
 *   yarn verify:pdf
 *   yarn verify:pdf "C:\path\to\file.pdf"
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const arg = process.argv[2];
const defaultPath = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  'Downloads',
  'Telegram Desktop',
  'Выписка по счету за 01.04.2026-15.04.2026 (2).pdf',
);
const pdfPath = arg ? path.resolve(arg) : defaultPath;

async function main() {
  if (!fs.existsSync(pdfPath)) {
    console.error('Файл не найден:', pdfPath);
    console.error('Укажите путь: yarn verify:pdf "C:\\...\\выписка.pdf"');
    process.exit(1);
  }

  const buffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buffer });
  try {
    const t = await parser.getText();
    console.log('OK — страниц:', t.pages?.length ?? '?', '| длина текста:', t.text.length);
    console.log('\n--- превью (600 символов) ---\n');
    console.log(t.text.slice(0, 1600));
    console.log('\n--- конец превью ---');
  } finally {
    await parser.destroy();
  }
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});

