-- Fix categories with invalid icons (emojis, custom icons, etc.)
-- Only Material Icons from the app are allowed.
-- Run once. Categories with invalid icons will get the default 'category' icon.

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
