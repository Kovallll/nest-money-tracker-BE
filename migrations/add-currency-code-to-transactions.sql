-- Add currency_code to transactions for multi-currency support.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'BYN';

COMMENT ON COLUMN transactions.currency_code IS 'ISO 4217 currency code (BYN, USD, EUR, RUB)';
