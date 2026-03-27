-- Убрать дубль: total_income и total_revenues → одно поле total_revenue (согласовано с type = 'revenue' в transactions).

ALTER TABLE statistics ADD COLUMN IF NOT EXISTS total_revenue DECIMAL(15, 2) DEFAULT 0;

DO $$
DECLARE
    has_rev boolean;
    has_inc boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'statistics' AND column_name = 'total_revenues')
    INTO has_rev;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'statistics' AND column_name = 'total_income')
    INTO has_inc;

    IF has_rev AND has_inc THEN
        UPDATE statistics SET total_revenue = COALESCE(total_revenues, total_income, 0);
    ELSIF has_rev THEN
        UPDATE statistics SET total_revenue = COALESCE(total_revenues, 0);
    ELSIF has_inc THEN
        UPDATE statistics SET total_revenue = COALESCE(total_income, 0);
    END IF;
END $$;

ALTER TABLE statistics DROP COLUMN IF EXISTS total_income;
ALTER TABLE statistics DROP COLUMN IF EXISTS total_revenues;
