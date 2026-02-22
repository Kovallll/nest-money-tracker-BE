-- Add profile fields to users if your schema does not have them yet.
-- Run once. If a column already exists, the statement for that column will fail (safe to ignore or run individually).

ALTER TABLE users ADD COLUMN IF NOT EXISTS lastname VARCHAR(255) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar VARCHAR(500);
