-- Add user_id to categories for per-user category ownership.
-- Base/seed categories have user_id = NULL (visible to all).
-- Custom categories get user_id of the creating user.

-- Add column if not exists
ALTER TABLE categories
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- Migrate existing data: seed/base categories stay NULL, others assign to first user
-- Seed category names (must match backend seed)
UPDATE categories
SET user_id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
WHERE user_id IS NULL
  AND name NOT IN (
    'Auto', 'Transport', 'Food', 'Shopping', 'Entertainments',
    'Courses', 'Medicine', 'Other'
  );

-- Index for efficient user lookups
CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
