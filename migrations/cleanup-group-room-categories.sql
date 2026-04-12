-- Оставить у групповых комнат только категории Goals и Subscriptions.
-- Ссылки на удаляемые категории обнуляются (или каскадом).

UPDATE group_transactions gt
SET category_id = NULL
FROM categories c
WHERE gt.category_id = c.id
  AND c.group_room_id IS NOT NULL
  AND c.name NOT IN ('Goals', 'Subscriptions');

UPDATE group_budgets gb
SET category_id = NULL
FROM categories c
WHERE gb.category_id = c.id
  AND c.group_room_id IS NOT NULL
  AND c.name NOT IN ('Goals', 'Subscriptions');

UPDATE goals g
SET category_id = NULL
FROM categories c
WHERE g.category_id = c.id
  AND c.group_room_id IS NOT NULL
  AND c.name NOT IN ('Goals', 'Subscriptions');

UPDATE subscriptions s
SET category_id = NULL
FROM categories c
WHERE s.category_id = c.id
  AND c.group_room_id IS NOT NULL
  AND c.name NOT IN ('Goals', 'Subscriptions');

DELETE FROM examples
WHERE category_id IN (
  SELECT id FROM categories
  WHERE group_room_id IS NOT NULL
    AND name NOT IN ('Goals', 'Subscriptions')
);

DELETE FROM categories
WHERE group_room_id IS NOT NULL
  AND name NOT IN ('Goals', 'Subscriptions');

-- На каждую комнату — дефолтные две категории, если их не было
INSERT INTO categories (id, name, icon, color, user_id, group_room_id, updated_at)
SELECT gen_random_uuid(), x.name, x.icon, x.color, NULL, r.id, NOW()
FROM group_rooms r
CROSS JOIN (
  VALUES
    ('Goals'::text, 'savings'::text, '#10B981'::text),
    ('Subscriptions'::text, 'subscriptions'::text, '#7C3AED'::text)
) AS x(name, icon, color)
WHERE NOT EXISTS (
  SELECT 1 FROM categories c
  WHERE c.group_room_id = r.id AND c.name = x.name
);
