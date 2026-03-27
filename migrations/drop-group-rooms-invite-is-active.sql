-- Убрать мягкое отключение: комнату и приглашение отключаем удалением строки.

DROP INDEX IF EXISTS idx_group_rooms_is_active;

ALTER TABLE group_rooms DROP COLUMN IF EXISTS is_active;
ALTER TABLE group_invite_links DROP COLUMN IF EXISTS is_active;
