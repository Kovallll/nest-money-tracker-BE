-- Add currency_code column to goals table for multi-currency support.

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'BYN';

COMMENT ON COLUMN goals.currency_code IS 'ISO 4217 currency code (BYN, USD, EUR, RUB)';
