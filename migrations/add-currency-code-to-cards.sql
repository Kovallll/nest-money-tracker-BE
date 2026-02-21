-- Add currency_code column to cards table for multi-currency support.
-- Run this once against your PostgreSQL database (e.g. psql or your migration runner).

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'BYN';

COMMENT ON COLUMN cards.currency_code IS 'ISO 4217 currency code (BYN, USD, EUR, RUB)';
