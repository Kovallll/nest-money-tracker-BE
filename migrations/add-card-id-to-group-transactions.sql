-- Личная карта плательщика (paid_by) для групповой траты: баланс карты уменьшается как при расходе.
ALTER TABLE group_transactions
    ADD COLUMN IF NOT EXISTS card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_group_transactions_card_id ON group_transactions(card_id);
