import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Помечает маршрут как публичный (без JWT).
 * Использование: @Public() на методе контроллера.
 * Требует guard, который проверяет SetMetadata(IS_PUBLIC_KEY) и пропускает запрос.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
