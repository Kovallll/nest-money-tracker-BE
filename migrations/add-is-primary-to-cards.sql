-- Add is_primary to cards: one card per user is "primary" (used for automatic transactions).
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- Ensure only one primary card per user (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_one_primary_per_user
  ON cards (user_id) WHERE is_primary = TRUE;

-- Backfill: set first card (by id) of each user as primary.
UPDATE cards c
SET is_primary = TRUE
FROM (
  SELECT DISTINCT ON (user_id) id FROM cards ORDER BY user_id, id ASC
) first_per_user
WHERE c.id = first_per_user.id;
