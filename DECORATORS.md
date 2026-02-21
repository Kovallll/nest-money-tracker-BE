# Декораторы в проекте

## Уже добавлены

### `@CurrentUser(data?)`
**Файл:** `src/common/decorators/current-user.decorator.ts`

Достаёт пользователя из `request.user` (после JwtAuthGuard).

```ts
// Весь объект пользователя
@Get('me')
me(@CurrentUser() user: { id: string; email: string; name: string }) {
  return user;
}

// Только поле (например id)
@Get('profile')
getProfile(@CurrentUser('id') userId: string) {
  return this.usersService.getProfile(userId);
}
```

### `@Public()`
**Файл:** `src/common/decorators/public.decorator.ts`

Помечает маршрут как доступный без JWT. Используется на контроллерах с `@UseGuards(JwtAuthGuard)`.

```ts
@Get('vapid-key')
@Public()
getVapidPublicKey() {
  return { publicKey: process.env.VAPID_PUBLIC_KEY };
}
```

**Сервер-сервер:** если задан `API_KEY`, любой защищённый маршрут можно вызывать с заголовком `X-API-Key` или `Authorization: Bearer <API_KEY>` без JWT. Подробнее — в `DTO-VALIDATION.md`.

---

## Что можно добавить

### 1. Валидация (class-validator + ValidationPipe)

Установка: `npm i class-validator class-transformer`

В `main.ts`:
```ts
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
```

В DTO:
```ts
// create-transaction.dto.ts
import { IsString, IsNumber, IsOptional, Min } from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  title: string;
  @IsNumber()
  @Min(0.01)
  amount: number;
  @IsString()
  date: string;
  @IsString()
  type: 'expense' | 'revenue';
  @IsOptional()
  @IsString()
  description?: string;
  // ...
}
```

В контроллере: `@Body() dto: CreateTransactionDto` — тело будет проверяться автоматически.

---

### 2. Swagger / OpenAPI

Установка: `npm i @nestjs/swagger`

В `main.ts`:
```ts
const config = new DocumentBuilder()
  .setTitle('Finance API')
  .setVersion('1.0')
  .addBearerAuth()
  .build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api/docs', app, document);
```

Декораторы на контроллерах и DTO:
- `@ApiTags('transactions')` — группа в документации
- `@ApiBearerAuth()` — требовать JWT
- `@ApiOperation({ summary: 'Создать транзакцию' })`
- `@ApiResponse({ status: 201, description: 'Created' })`
- На DTO: `@ApiProperty()`, `@ApiPropertyOptional()`

---

### 3. Rate limiting (Throttler)

Установка: `npm i @nestjs/throttler`

В модуле:
```ts
ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
```

Декораторы:
- `@Throttle(5, 60)` — 5 запросов за 60 секунд на этот маршрут
- `@SkipThrottle()` — не лимитировать маршрут

---

### 4. Роли и права

Кастомный декоратор:
```ts
// roles.decorator.ts
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

Guard проверяет `req.user.role` и сравнивает с `roles`. На маршрут: `@Roles('admin')`.

---

### 5. Кэширование

Установка: `npm i @nestjs/cache-manager cache-manager`

Декораторы (с CacheInterceptor):
- `@CacheKey('custom-key')`
- `@CacheTTL(60)` — время жизни в секундах

---

### 6. Стандартные Nest/Express

- `@Req()` — полный request
- `@Res()` — response (осторожно с интерцепторами)
- `@Headers('x-custom')` — заголовок
- `@Ip()` — IP клиента
- `@Param('id')` — параметр пути
- `@Query('page')` — query-параметр
- `@Body()` — тело запроса

Имеет смысл в первую очередь добавить **ValidationPipe + DTO с class-validator** и при необходимости **Swagger** для документации API.
