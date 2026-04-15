-- Способ оплаты для групповых транзакций (наличные / карта), как у личных.
ALTER TABLE group_transactions
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'card'));

COMMENT ON COLUMN group_transactions.payment_method IS 'cash | card; при cash card_id обычно NULL, баланс карты не меняется';
