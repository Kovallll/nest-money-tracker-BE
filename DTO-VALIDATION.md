# Валидация и DTO

## Глобальный ValidationPipe (main.ts)

- **whitelist: true** — лишние поля в теле запроса отбрасываются
- **forbidNonWhitelisted: true** — при лишних полях возвращается 400
- **transform: true** — примитивы из query/params приводятся к типам (например, строка к number)
- **transformOptions: { enableImplicitConversion: true }** — неявное преобразование типов

Используются пакеты **class-validator** и **class-transformer** (уже в `package.json`).

---

## Где лежат DTO

| Модуль        | Путь                         | Файлы |
|---------------|------------------------------|--------|
| Auth          | `src/auth/dto/`              | RegisterDto, LoginDto, RefreshDto |
| Transactions  | `src/models/transactions/dto/` | CreateTransactionDto, UpdateTransactionDto |
| Cards         | `src/models/cards/dto/`      | CreateCardDto, UpdateCardDto |
| Categories    | `src/models/categories/dto/` | CreateCategoryDto, UpdateCategoryDto, AddExampleDto |
| Goals         | `src/models/goals/dto/`      | CreateGoalDto, UpdateGoalDto |
| Subscriptions | `src/models/subscribtions/dto/` | CreateSubscriptionDto, UpdateSubscriptionDto |
| Push          | `src/push/dto/`              | SubscribePushDto, SendNotificationDto |
| Categorizer   | `src/categorizer/dto/`       | PredictCategoryDto, RetrainDto |
| Users         | `src/users/dto/`             | UpdateProfileDto, ChangePasswordDto |

Во всех перечисленных контроллерах в `@Body()` передаются эти DTO — валидация выполняется до входа в метод.

---

## Примеры сообщений при ошибках

- Неверный email: `"Некорректный email"`
- Короткий пароль: `"Пароль не менее 6 символов"`
- Лишнее поле в теле: 400 и список `property ... should not exist`
- Не пройдена валидация: 400 с массивом `message` по каждому полю (стандартный формат Nest + class-validator)
