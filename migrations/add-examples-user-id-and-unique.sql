-- Примеры категорий: владелец (для deleteAccount) и уникальность (category_id, text) для ON CONFLICT.

ALTER TABLE examples
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS examples_category_id_text_unique
  ON examples (category_id, text);
