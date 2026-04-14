ALTER TABLE users
ADD COLUMN IF NOT EXISTS push_timezone VARCHAR(64);

CREATE TABLE IF NOT EXISTS push_daily_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL,
  local_date DATE NOT NULL,
  timezone VARCHAR(64) NOT NULL,
  payload JSONB,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, notification_type, local_date)
);

CREATE INDEX IF NOT EXISTS idx_push_daily_logs_type_date
  ON push_daily_logs(notification_type, local_date);

CREATE INDEX IF NOT EXISTS idx_push_daily_logs_user_sent_at
  ON push_daily_logs(user_id, sent_at DESC);
