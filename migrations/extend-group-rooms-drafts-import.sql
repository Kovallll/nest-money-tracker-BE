-- Групповые комнаты, сплиты, черновики транзакций, импорт выписок, переводы между картами.
-- Идемпотентно: повторный запуск безопасен (IF NOT EXISTS / DROP IF EXISTS где нужно).

-- ---------------------------------------------------------------------------
-- Существующие таблицы
-- ---------------------------------------------------------------------------

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS transfer_to_card_id INTEGER
        REFERENCES cards(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS transfer_amount DECIMAL(15, 2);

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions
    ADD CONSTRAINT transactions_type_check
        CHECK (type IN ('expense', 'revenue', 'transfer'));

ALTER TABLE push_notifications
    ADD COLUMN IF NOT EXISTS room_id UUID;

ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS group_room_id UUID,
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- group_rooms (до FK из categories / push_notifications)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS group_rooms (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(255) NOT NULL,
    description   TEXT,
    avatar        VARCHAR(500),
    currency_code VARCHAR(3)   NOT NULL DEFAULT 'BYN',
    created_by    UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

ALTER TABLE categories DROP CONSTRAINT IF EXISTS fk_categories_group_room;
ALTER TABLE categories
    ADD CONSTRAINT fk_categories_group_room
        FOREIGN KEY (group_room_id) REFERENCES group_rooms(id) ON DELETE CASCADE;

ALTER TABLE push_notifications DROP CONSTRAINT IF EXISTS fk_push_notifications_group_room;
ALTER TABLE push_notifications
    ADD CONSTRAINT fk_push_notifications_group_room
        FOREIGN KEY (room_id) REFERENCES group_rooms(id) ON DELETE SET NULL;

ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_user_or_room_check;
ALTER TABLE categories
    ADD CONSTRAINT categories_user_or_room_check
        CHECK (NOT (user_id IS NOT NULL AND group_room_id IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Импорт и черновики
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS import_sessions (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source          VARCHAR(20)  NOT NULL
                        CHECK (source IN ('csv', 'xlsx', 'pdf', 'ofx', 'other')),
    filename        VARCHAR(255),
    status          VARCHAR(30)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                            'pending', 'processing',
                            'awaiting_confirmation', 'completed', 'failed'
                        )),
    total_rows      INTEGER      DEFAULT 0,
    imported_rows   INTEGER      DEFAULT 0,
    failed_rows     INTEGER      DEFAULT 0,
    error_message   TEXT,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS transaction_drafts (
    id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source            VARCHAR(20)     NOT NULL
                          CHECK (source IN ('telegram', 'ocr', 'import')),
    import_session_id UUID            REFERENCES import_sessions(id) ON DELETE SET NULL,
    card_id           INTEGER         REFERENCES cards(id) ON DELETE SET NULL,
    category_id       UUID            REFERENCES categories(id) ON DELETE SET NULL,
    type              VARCHAR(20)     CHECK (type IN ('expense', 'revenue', 'transfer')),
    amount            DECIMAL(15, 2),
    currency_code     VARCHAR(3)      DEFAULT 'BYN',
    title             VARCHAR(255),
    description       TEXT,
    date              DATE,
    raw_data          JSONB,
    status            VARCHAR(20)     NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'confirmed', 'rejected')),
    created_at        TIMESTAMPTZ     DEFAULT NOW(),
    expires_at        TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Участники и приглашения
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS group_members (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id     UUID        NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        VARCHAR(20) NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member')),
    invited_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_invite_links (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id     UUID        NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
    created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(64) UNIQUE NOT NULL,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Групповые транзакции и сплиты
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS group_transactions (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id       UUID            NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
    paid_by       UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_by    UUID            REFERENCES users(id) ON DELETE SET NULL,
    category_id   UUID            REFERENCES categories(id) ON DELETE SET NULL,
    amount        DECIMAL(15, 2)  NOT NULL,
    currency_code VARCHAR(3)      NOT NULL DEFAULT 'BYN',
    title         VARCHAR(255)    NOT NULL,
    description   TEXT,
    date          DATE            NOT NULL,
    is_split      BOOLEAN         DEFAULT FALSE,
    created_at    TIMESTAMPTZ     DEFAULT NOW(),
    updated_at    TIMESTAMPTZ     DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_splits (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID        NOT NULL REFERENCES group_transactions(id) ON DELETE CASCADE,
    created_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
    split_method   VARCHAR(20) NOT NULL
                       CHECK (split_method IN ('equal', 'percent', 'fixed')),
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_split_participants (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    split_id      UUID            NOT NULL REFERENCES group_splits(id) ON DELETE CASCADE,
    user_id       UUID            NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    share_amount  DECIMAL(15, 2)  NOT NULL,
    share_percent DECIMAL(5, 2),
    status        VARCHAR(25)     NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'settle_requested', 'confirmed')),
    settled_at    TIMESTAMPTZ,
    confirmed_at  TIMESTAMPTZ,
    UNIQUE (split_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_debts (
    id                   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id              UUID            NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
    split_participant_id UUID            REFERENCES group_split_participants(id) ON DELETE SET NULL,
    debtor_id            UUID            NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    creditor_id          UUID            NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount               DECIMAL(15, 2)  NOT NULL,
    currency_code        VARCHAR(3)      NOT NULL DEFAULT 'BYN',
    status               VARCHAR(25)     NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'settle_requested', 'settled')),
    settle_requested_at  TIMESTAMPTZ,
    settled_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ    DEFAULT NOW(),
    updated_at           TIMESTAMPTZ    DEFAULT NOW(),
    CHECK (debtor_id <> creditor_id)
);

-- Бюджеты: обычный UNIQUE (room_id, category_id, period) не запрещает дубли при category_id NULL.
CREATE TABLE IF NOT EXISTS group_budgets (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id       UUID            NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
    category_id   UUID            REFERENCES categories(id) ON DELETE SET NULL,
    amount        DECIMAL(15, 2)  NOT NULL,
    period        VARCHAR(20)     NOT NULL DEFAULT 'monthly'
                      CHECK (period IN ('weekly', 'monthly', 'yearly')),
    created_by    UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ     DEFAULT NOW(),
    updated_at    TIMESTAMPTZ     DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_budgets_room_period_general
    ON group_budgets (room_id, period) WHERE category_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_budgets_room_cat_period
    ON group_budgets (room_id, category_id, period) WHERE category_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_activity_log (
    id          BIGSERIAL    PRIMARY KEY,
    room_id     UUID         NOT NULL REFERENCES group_rooms(id) ON DELETE CASCADE,
    actor_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    action_type VARCHAR(60)  NOT NULL,
    entity_type VARCHAR(50),
    entity_id   TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Индексы
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_import_sessions_user_id ON import_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_transaction_drafts_user_id ON transaction_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_transaction_drafts_status ON transaction_drafts(status);
CREATE INDEX IF NOT EXISTS idx_transaction_drafts_source ON transaction_drafts(source);
CREATE INDEX IF NOT EXISTS idx_transaction_drafts_import_session ON transaction_drafts(import_session_id);

CREATE INDEX IF NOT EXISTS idx_categories_group_room_id ON categories(group_room_id);

CREATE INDEX IF NOT EXISTS idx_transactions_transfer_to_card ON transactions(transfer_to_card_id);
CREATE INDEX IF NOT EXISTS idx_push_notifications_room_id ON push_notifications(room_id);

CREATE INDEX IF NOT EXISTS idx_group_rooms_created_by ON group_rooms(created_by);

CREATE INDEX IF NOT EXISTS idx_group_members_room_id ON group_members(room_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_room_role ON group_members(room_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_one_owner_per_room
    ON group_members (room_id) WHERE role = 'owner';

CREATE INDEX IF NOT EXISTS idx_group_invite_links_room_id ON group_invite_links(room_id);
CREATE INDEX IF NOT EXISTS idx_group_invite_links_token ON group_invite_links(token);

CREATE INDEX IF NOT EXISTS idx_group_transactions_room_id ON group_transactions(room_id);
CREATE INDEX IF NOT EXISTS idx_group_transactions_paid_by ON group_transactions(paid_by);
CREATE INDEX IF NOT EXISTS idx_group_transactions_date ON group_transactions(date);
CREATE INDEX IF NOT EXISTS idx_group_transactions_category_id ON group_transactions(category_id);

CREATE INDEX IF NOT EXISTS idx_group_splits_transaction_id ON group_splits(transaction_id);

CREATE INDEX IF NOT EXISTS idx_group_split_participants_split_id ON group_split_participants(split_id);
CREATE INDEX IF NOT EXISTS idx_group_split_participants_user_id ON group_split_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_group_split_participants_status ON group_split_participants(status);

CREATE INDEX IF NOT EXISTS idx_group_debts_room_id ON group_debts(room_id);
CREATE INDEX IF NOT EXISTS idx_group_debts_debtor_id ON group_debts(debtor_id);
CREATE INDEX IF NOT EXISTS idx_group_debts_creditor_id ON group_debts(creditor_id);
CREATE INDEX IF NOT EXISTS idx_group_debts_status ON group_debts(status);

CREATE INDEX IF NOT EXISTS idx_group_budgets_room_id ON group_budgets(room_id);

CREATE INDEX IF NOT EXISTS idx_group_activity_log_room_id ON group_activity_log(room_id);
CREATE INDEX IF NOT EXISTS idx_group_activity_log_actor_id ON group_activity_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_group_activity_log_created_at ON group_activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_activity_log_action_type ON group_activity_log(action_type);

-- ---------------------------------------------------------------------------
-- Комментарии
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN group_rooms.created_by IS
    'Создатель комнаты; RESTRICT при удалении пользователя, пока он created_by (передайте владельца или удалите комнату).';
COMMENT ON COLUMN group_transactions.paid_by IS
    'Кто фактически оплатил; SET NULL при удалении пользователя — запись сохраняется.';
COMMENT ON COLUMN group_debts.status IS
    'pending → settle_requested → settled.';
COMMENT ON COLUMN group_split_participants.status IS
    'pending → settle_requested → confirmed.';
COMMENT ON COLUMN group_activity_log.metadata IS
    'Контекст события (JSONB).';
COMMENT ON COLUMN transaction_drafts.raw_data IS
    'Сырые данные: Telegram, OCR, строка импорта.';
COMMENT ON COLUMN transaction_drafts.expires_at IS
    'Автоотмена черновика по сроку (логика в приложении).';
COMMENT ON COLUMN categories.group_room_id IS
    'Групповая категория: задан group_room_id, user_id NULL. Личная: user_id, group_room_id NULL. Шаблон: оба NULL.';
