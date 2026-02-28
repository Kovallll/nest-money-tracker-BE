-- Replace branch_name with expiry (month/year) for cards.
-- expiry format: "MM/YY" (e.g. "12/28" for December 2028)

ALTER TABLE cards ADD COLUMN IF NOT EXISTS expiry VARCHAR(5);
ALTER TABLE cards DROP COLUMN IF EXISTS branch_name;
