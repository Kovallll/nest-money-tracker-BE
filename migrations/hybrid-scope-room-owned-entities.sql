-- Гибридный скоуп: goals, subscriptions, expenses, statistics — личное (user_id) XOR комната (group_room_id).
-- Транзакции остаются раздельно: transactions (личные) и group_transactions (комнатные).
-- Идемпотентно: безопасен для повторного запуска.

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS group_room_id UUID REFERENCES group_rooms(id) ON DELETE CASCADE;

ALTER TABLE expenses ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_user_or_room_check;
ALTER TABLE expenses
    ADD CONSTRAINT expenses_user_or_room_check CHECK (
        (user_id IS NOT NULL AND group_room_id IS NULL)
        OR (user_id IS NULL AND group_room_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_expenses_group_room_id ON expenses(group_room_id);

-- ---------------------------------------------------------------------------
-- goals
-- ---------------------------------------------------------------------------
ALTER TABLE goals
    ADD COLUMN IF NOT EXISTS group_room_id UUID REFERENCES group_rooms(id) ON DELETE CASCADE;

ALTER TABLE goals ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_user_or_room_check;
ALTER TABLE goals
    ADD CONSTRAINT goals_user_or_room_check CHECK (
        (user_id IS NOT NULL AND group_room_id IS NULL)
        OR (user_id IS NULL AND group_room_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_goals_group_room_id ON goals(group_room_id);

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS group_room_id UUID REFERENCES group_rooms(id) ON DELETE CASCADE;

ALTER TABLE subscriptions ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_or_room_check;
ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_user_or_room_check CHECK (
        (user_id IS NOT NULL AND group_room_id IS NULL)
        OR (user_id IS NULL AND group_room_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_subscriptions_group_room_id ON subscriptions(group_room_id);

-- ---------------------------------------------------------------------------
-- statistics (замена UNIQUE(user_id, period, date_period) на частичные индексы)
-- ---------------------------------------------------------------------------
ALTER TABLE statistics
    ADD COLUMN IF NOT EXISTS group_room_id UUID REFERENCES group_rooms(id) ON DELETE CASCADE;

ALTER TABLE statistics ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE statistics DROP CONSTRAINT IF EXISTS statistics_user_id_period_date_period_key;
ALTER TABLE statistics DROP CONSTRAINT IF EXISTS statistics_user_id_period_dateperiod_key;

ALTER TABLE statistics DROP CONSTRAINT IF EXISTS statistics_user_or_room_check;
ALTER TABLE statistics
    ADD CONSTRAINT statistics_user_or_room_check CHECK (
        (user_id IS NOT NULL AND group_room_id IS NULL)
        OR (user_id IS NULL AND group_room_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_statistics_group_room_id ON statistics(group_room_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_statistics_user_period_date
    ON statistics (user_id, period, date_period) WHERE user_id IS NOT NULL AND group_room_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_statistics_room_period_date
    ON statistics (group_room_id, period, date_period) WHERE group_room_id IS NOT NULL;

COMMENT ON COLUMN goals.group_room_id IS 'Цель комнаты: group_room_id; личная: user_id.';
COMMENT ON COLUMN subscriptions.group_room_id IS 'Подписка комнаты: group_room_id; личная: user_id.';
COMMENT ON COLUMN expenses.group_room_id IS 'Расход комнаты: group_room_id; личный: user_id.';
COMMENT ON COLUMN statistics.group_room_id IS 'Агрегаты по комнате; личные строки с user_id.';
