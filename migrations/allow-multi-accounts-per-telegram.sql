-- Allow one Telegram account to be linked to multiple app accounts.
-- Keep one active Telegram per app account via PRIMARY KEY(user_id).

ALTER TABLE user_telegram
DROP CONSTRAINT IF EXISTS user_telegram_telegram_user_id_key;

CREATE INDEX IF NOT EXISTS idx_user_telegram_telegram_user_id
ON user_telegram (telegram_user_id);
