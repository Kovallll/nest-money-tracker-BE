ALTER TABLE group_transactions
    ADD COLUMN IF NOT EXISTS transfer_to_card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_group_transactions_transfer_to_card
    ON group_transactions(transfer_to_card_id);
