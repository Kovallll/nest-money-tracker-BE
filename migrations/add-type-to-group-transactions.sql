-- Тип комнатной транзакции: expense | revenue (как у личных transactions).
ALTER TABLE group_transactions
    ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'expense';
