-- Add currency_code column to subscriptions table for multi-currency support.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'BYN';

COMMENT ON COLUMN subscriptions.currency_code IS 'ISO 4217 currency code (BYN, USD, EUR, RUB)';
