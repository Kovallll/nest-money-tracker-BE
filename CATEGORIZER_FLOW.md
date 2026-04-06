# Categorizer Flow (Current)

## End-to-End

1. Frontend calls `POST /api/categorizer/predict` while user types a transaction title.
2. Backend `CategorizerService`:
   - normalizes input text;
   - builds cache key with model version + user scope;
   - returns trusted cache hit or asks ML service.
3. Backend returns prediction payload with `predictionKey`.
4. Frontend saves `predictionKey` + `predictedCategoryId` and sends them on create/update transaction.
5. Backend compares predicted vs actual category:
   - updates redis quality counters;
   - writes persistent row into `categorizer_feedback`.

## Cache Quality Rules

- Good: at least 3 accepts and accuracy >= 0.7.
- Bad: rejected >= 3 and accepted == 0.
- Bad entries are invalidated.
- Good entries have TTL refreshed.

## Safety Rules

- Unknown/empty category from ML is normalized to:
  - `category_id = ''`
  - `category_name = 'Неизвестно'`
  - `needs_confirmation = true`
- Frontend never auto-applies unknown category ids.

## Почему «Неизвестно» при вводе текста (напр. «одежда»)

1. **Python / FastText**: метка `__label__<id>` должна совпасть с id категории в `categories_cache`. Расхождение UUID (регистр, пробелы) или устаревший id в весах → «Неизвестно».
2. **Лексикон (Nest)**: подставляет категорию только если **название категории в БД** как-то совпадает с текстом (подстрока, префикс, нормализация ё/е). **Разные языки** («одежда» vs «Shopping») **не связываются** — это не семантический поиск.
3. **Что помогает**: переименовать категорию под свой язык, добавить **примеры** в обучение (транзакции → examples), или дождаться обучения с **именем категории** в датасете (classifier добавляет `name` в строки обучения). После смены данных — **retrain** ML.

## Metrics

- Endpoint: `GET /api/categorizer/metrics?days=30`
- Source: `categorizer_feedback` table.
- Returns:
  - total/accepted/rejected/unknown
  - acceptanceRate
  - unknownRate
