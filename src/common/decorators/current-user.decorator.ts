import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Достаёт текущего пользователя из request (после JwtAuthGuard).
 * Использование: @CurrentUser() user: { id: string; email: string; name: string }
 * или только id: @CurrentUser('id') userId: string
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
