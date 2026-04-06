import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '@/pg/pg.module';

@Injectable()
export class RoomMembershipService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async assertRoomMember(roomId: string, userId: string): Promise<void> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM group_members WHERE room_id = $1 AND user_id = $2 LIMIT 1',
      [roomId, userId],
    );
    if (!rows.length) {
      throw new ForbiddenException('Нет доступа к этой комнате');
    }
  }

  /** Личные данные: только сам пользователь (или service account). */
  assertPersonalAccess(
    targetUserId: string,
    requesterId: string,
    isService?: boolean,
  ): void {
    if (isService) return;
    if (targetUserId !== requesterId) {
      throw new ForbiddenException('Нет доступа к данным другого пользователя');
    }
  }
}
