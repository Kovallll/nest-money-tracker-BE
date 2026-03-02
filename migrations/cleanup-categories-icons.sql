-- Очистка категорий: установка правильных иконок и цветов по имени.
-- Соответствует базовым категориям из backend/src/models/categories/seed.ts
-- Запускать после add-user-id-to-categories.sql

-- 1. Установить иконки и цвета для известных базовых категорий (по имени)
UPDATE categories SET icon = 'directions_car', color = '#FF6B6B' WHERE LOWER(TRIM(name)) = 'auto';
UPDATE categories SET icon = 'local_taxi',   color = '#4ECDC4' WHERE LOWER(TRIM(name)) = 'transport';
UPDATE categories SET icon = 'restaurant',   color = '#45B7D1' WHERE LOWER(TRIM(name)) = 'food';
UPDATE categories SET icon = 'shopping_cart', color = '#96CEB4' WHERE LOWER(TRIM(name)) = 'shopping';
UPDATE categories SET icon = 'movie',        color = '#FFEAA7' WHERE LOWER(TRIM(name)) IN ('entertainments', 'entertainment');
UPDATE categories SET icon = 'school',       color = '#F7DC6F' WHERE LOWER(TRIM(name)) IN ('courses', 'course');
UPDATE categories SET icon = 'local_hospital', color = '#98D8C8' WHERE LOWER(TRIM(name)) IN ('medicine', 'med');
UPDATE categories SET icon = 'category',     color = '#DDA0DD' WHERE LOWER(TRIM(name)) = 'other';

-- 2. Категории с некорректными/пустыми иконками получают дефолтную
UPDATE categories
SET icon = 'category'
WHERE icon IS NULL
   OR icon = ''
   OR icon NOT IN (
     'directions_car',
     'local_taxi',
     'restaurant',
     'shopping_cart',
     'movie',
     'school',
     'local_hospital',
     'receipt',
     'subscriptions',
     'savings',
     'account_balance',
     'category',
     'inventory_2'
   );
