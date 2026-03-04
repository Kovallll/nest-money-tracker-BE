-- Add created_at and updated_at to categories (created_at = when category was created, updated_at = when edited or when a transaction is added).
ALTER TABLE categories
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE categories
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill existing rows
UPDATE categories SET created_at = NOW() WHERE created_at IS NULL;
UPDATE categories SET updated_at = NOW() WHERE updated_at IS NULL;
