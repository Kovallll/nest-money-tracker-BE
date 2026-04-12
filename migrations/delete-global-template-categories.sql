-- Удаление глобальных шаблонов категорий: user_id IS NULL и group_room_id IS NULL.
-- Не трогает личные категории (user_id задан) и категории комнат (group_room_id задан).
--
-- Эффекты по FK (database.sql):
--   examples          → ON DELETE CASCADE (примеры шаблонов удалятся вместе с категорией)
--   transactions      → category_id SET NULL
--   goals/subscriptions / group_transactions / group_budgets / transaction_drafts → SET NULL
--
-- После миграции задайте в окружении бэкенда:
--   SEED_GLOBAL_CATEGORY_SEED=false
-- иначе при следующем старте Nest снова создаст строки из seed.ts.
--
-- Регистрация новых пользователей: ensureDefaultPersonalCategories подставит Goals/Subscriptions
-- из fallback (см. categories.service.ts), если глобальных шаблонов нет.

DELETE FROM categories
WHERE user_id IS NULL
  AND group_room_id IS NULL;
