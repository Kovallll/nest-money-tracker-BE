-- Add payment_method column to transactions (optional: 'cash' or 'card').
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);
