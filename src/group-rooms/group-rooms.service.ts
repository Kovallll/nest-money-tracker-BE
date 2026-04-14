import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { randomBytes } from 'crypto';
import { PG_POOL } from '@/pg/pg.module';
import {
  CreateGroupInviteDto,
  CreateGroupRoomDto,
  CreateGroupTransactionDto,
  UpdateGroupMemberRoleDto,
  UpdateGroupRoomDto,
  UpdateGroupTransactionDto,
} from './dto';
import { GroupRoomsEventsService } from './group-rooms-events.service';
import { TransactionsService } from '@/models/transactions/transactions.service';

type GroupRole = 'owner' | 'admin' | 'member';

export type RoomContributionMemberDto = {
  userId: string;
  name: string;
  amount: number;
  currencyCode: string;
};

export type RoomContributionsResponseDto = {
  totalsByMember: RoomContributionMemberDto[];
  byCategory: Array<{
    categoryId: string | null;
    categoryName: string;
    members: RoomContributionMemberDto[];
  }>;
};

@Injectable()
export class GroupRoomsService implements OnModuleInit {
  private readonly logger = new Logger(GroupRoomsService.name);
  /** unknown → проверить БД; yes → колонка есть; no → колонки нет (запросы без падения). */
  private groupTxCardIdState: 'unknown' | 'yes' | 'no' = 'unknown';
  private groupTxTypeState: 'unknown' | 'yes' | 'no' = 'unknown';
  private groupTxAffectsState: 'unknown' | 'yes' | 'no' = 'unknown';

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly groupRoomsEvents: GroupRoomsEventsService,
    private readonly transactionsService: TransactionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureGroupTxCardIdColumn();
    await this.ensureGroupTxTypeColumn();
    await this.ensureGroupTxAffectsCardBalanceColumn();
  }

  private async queryGroupTxCardIdExists(): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'group_transactions'
         AND column_name = 'card_id'
       LIMIT 1`,
    );
    return rows.length > 0;
  }

  /** Добавить card_id отдельно от FK (надёжнее на старых БД / ограниченных правах). */
  private async tryAddGroupTxCardIdColumn(): Promise<void> {
    try {
      await this.pool.query(
        `ALTER TABLE group_transactions ADD COLUMN IF NOT EXISTS card_id INTEGER`,
      );
    } catch (err) {
      this.logger.warn(`group_transactions ADD card_id: ${(err as Error).message}`);
    }
    try {
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_group_transactions_card_id ON group_transactions(card_id)`,
      );
    } catch (err) {
      this.logger.warn(`group_transactions INDEX card_id: ${(err as Error).message}`);
    }
    try {
      await this.pool.query(`
        DO $$
        BEGIN
          ALTER TABLE group_transactions
            ADD CONSTRAINT group_transactions_card_id_fkey
            FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE SET NULL;
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END $$;
      `);
    } catch (err) {
      this.logger.warn(`group_transactions FK card_id: ${(err as Error).message}`);
    }
  }

  /** true, если можно читать/писать card_id; false — работаем без колонки (без 500). */
  private async ensureGroupTxCardIdColumn(): Promise<boolean> {
    if (this.groupTxCardIdState === 'yes') return true;
    if (this.groupTxCardIdState === 'no') return false;

    if (await this.queryGroupTxCardIdExists()) {
      this.groupTxCardIdState = 'yes';
      return true;
    }
    await this.tryAddGroupTxCardIdColumn();
    if (await this.queryGroupTxCardIdExists()) {
      this.groupTxCardIdState = 'yes';
      this.logger.log('group_transactions.card_id готова');
      return true;
    }
    this.groupTxCardIdState = 'no';
    this.logger.warn(
      'group_transactions.card_id отсутствует; групповые транзакции без привязки к карте до миграции БД',
    );
    return false;
  }

  private async queryGroupTxTypeExists(): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'group_transactions'
         AND column_name = 'type'
       LIMIT 1`,
    );
    return rows.length > 0;
  }

  private async tryAddGroupTxTypeColumn(): Promise<void> {
    try {
      await this.pool.query(
        `ALTER TABLE group_transactions ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'expense'`,
      );
    } catch (err) {
      this.logger.warn(`group_transactions ADD type: ${(err as Error).message}`);
    }
  }

  /** Колонка type (expense | revenue) для групповых транзакций. */
  private async ensureGroupTxTypeColumn(): Promise<boolean> {
    if (this.groupTxTypeState === 'yes') return true;
    if (this.groupTxTypeState === 'no') return false;

    if (await this.queryGroupTxTypeExists()) {
      this.groupTxTypeState = 'yes';
      return true;
    }
    await this.tryAddGroupTxTypeColumn();
    if (await this.queryGroupTxTypeExists()) {
      this.groupTxTypeState = 'yes';
      this.logger.log('group_transactions.type готова');
      return true;
    }
    this.groupTxTypeState = 'no';
    this.logger.warn(
      'group_transactions.type отсутствует; тип транзакции комнаты не сохраняется до миграции БД',
    );
    return false;
  }

  private async queryGroupTxAffectsExists(): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'group_transactions'
         AND column_name = 'affects_card_balance'
       LIMIT 1`,
    );
    return rows.length > 0;
  }

  private async tryAddGroupTxAffectsColumn(): Promise<void> {
    try {
      await this.pool.query(
        `ALTER TABLE group_transactions ADD COLUMN IF NOT EXISTS affects_card_balance BOOLEAN NOT NULL DEFAULT TRUE`,
      );
    } catch (err) {
      this.logger.warn(`group_transactions ADD affects_card_balance: ${(err as Error).message}`);
    }
  }

  private async ensureGroupTxAffectsCardBalanceColumn(): Promise<boolean> {
    if (this.groupTxAffectsState === 'yes') return true;
    if (this.groupTxAffectsState === 'no') return false;

    if (await this.queryGroupTxAffectsExists()) {
      this.groupTxAffectsState = 'yes';
      return true;
    }
    await this.tryAddGroupTxAffectsColumn();
    if (await this.queryGroupTxAffectsExists()) {
      this.groupTxAffectsState = 'yes';
      this.logger.log('group_transactions.affects_card_balance готова');
      return true;
    }
    this.groupTxAffectsState = 'no';
    this.logger.warn(
      'group_transactions.affects_card_balance отсутствует; флаг списания с карты не сохраняется до миграции БД',
    );
    return false;
  }

  private roleWeight(role: GroupRole): number {
    if (role === 'owner') return 3;
    if (role === 'admin') return 2;
    return 1;
  }

  private async getMemberRole(
    client: Pool | PoolClient,
    roomId: string,
    userId: string,
  ): Promise<GroupRole | null> {
    const { rows } = await client.query<{ role: GroupRole }>(
      'SELECT role FROM group_members WHERE room_id = $1 AND user_id = $2 LIMIT 1',
      [roomId, userId],
    );
    return rows[0]?.role ?? null;
  }

  private async ensureRole(
    client: Pool | PoolClient,
    roomId: string,
    userId: string,
    minRole: GroupRole = 'member',
  ): Promise<GroupRole> {
    const role = await this.getMemberRole(client, roomId, userId);
    if (!role) throw new ForbiddenException('Вы не состоите в этой комнате');
    if (this.roleWeight(role) < this.roleWeight(minRole)) {
      throw new ForbiddenException('Недостаточно прав для операции');
    }
    return role;
  }

  /** Базовые категории комнаты (цели и подписки), как в личном сиде. */
  private async seedDefaultRoomCategories(client: PoolClient, roomId: string): Promise<void> {
    await client.query(
      `INSERT INTO categories (id, name, icon, color, user_id, group_room_id, updated_at)
       SELECT gen_random_uuid(), x.name, x.icon, x.color, NULL, $1::uuid, NOW()
       FROM (
         VALUES
           ('Goals'::text, 'savings'::text, '#10B981'::text),
           ('Subscriptions'::text, 'subscriptions'::text, '#7C3AED'::text)
       ) AS x(name, icon, color)
       WHERE NOT EXISTS (
         SELECT 1 FROM categories c
         WHERE c.group_room_id = $1::uuid AND c.name = x.name
       )`,
      [roomId],
    );
  }

  private async appendActivity(
    client: Pool | PoolClient,
    roomId: string,
    actorId: string,
    actionType: string,
    entityType?: string,
    entityId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO group_activity_log (room_id, actor_id, action_type, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [roomId, actorId, actionType, entityType ?? null, entityId ?? null, metadata ?? null],
    );
  }

  async createRoom(userId: string, dto: CreateGroupRoomDto) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO group_rooms (name, description, avatar, currency_code, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, avatar, currency_code, created_by, created_at, updated_at`,
        [dto.name, dto.description ?? null, dto.avatar ?? null, dto.currencyCode ?? 'BYN', userId],
      );
      const room = rows[0];
      await client.query(
        `INSERT INTO group_members (room_id, user_id, role, invited_by)
         VALUES ($1, $2, 'owner', $2)`,
        [room.id, userId],
      );
      await this.seedDefaultRoomCategories(client, room.id);
      await this.appendActivity(client, room.id, userId, 'room_created', 'group_room', room.id);
      await client.query('COMMIT');
      await this.groupRoomsEvents.publishToUser(userId, {
        type: 'room_created',
        roomId: room.id,
        actorId: userId,
      });
      return room;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMyRooms(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT
         r.id,
         r.name,
         r.description,
         r.avatar,
         r.currency_code AS "currencyCode",
         gm.role,
         r.created_at AS "createdAt",
         r.updated_at AS "updatedAt",
         (
           SELECT COUNT(*)::int FROM group_members gm2 WHERE gm2.room_id = r.id
         ) AS "membersCount"
       FROM group_rooms r
       JOIN group_members gm ON gm.room_id = r.id
       WHERE gm.user_id = $1
       ORDER BY r.updated_at DESC, r.created_at DESC`,
      [userId],
    );
    return rows;
  }

  async getRoomDetails(roomId: string, userId: string) {
    await this.ensureRole(this.pool, roomId, userId, 'member');
    const roomRes = await this.pool.query(
      `SELECT
         id,
         name,
         description,
         avatar,
         currency_code AS "currencyCode",
         created_by AS "createdBy",
         created_at AS "createdAt",
         updated_at AS "updatedAt"
       FROM group_rooms
       WHERE id = $1
       LIMIT 1`,
      [roomId],
    );
    if (!roomRes.rows[0]) throw new NotFoundException('Комната не найдена');

    const membersRes = await this.pool.query(
      `SELECT
         gm.user_id AS "userId",
         gm.role,
         gm.invited_by AS "invitedBy",
         gm.joined_at AS "joinedAt",
         u.name,
         u.lastname,
         u.email,
         u.avatar
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.room_id = $1
       ORDER BY
         CASE gm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
         gm.joined_at ASC`,
      [roomId],
    );

    return { ...roomRes.rows[0], members: membersRes.rows };
  }

  async updateRoom(roomId: string, userId: string, dto: UpdateGroupRoomDto) {
    await this.ensureRole(this.pool, roomId, userId, 'admin');
    const parts: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (dto.name !== undefined) {
      const n = dto.name.trim();
      if (!n) throw new BadRequestException('Имя комнаты не может быть пустым');
      parts.push(`name = $${i++}`);
      values.push(n);
    }
    if (dto.description !== undefined) {
      parts.push(`description = $${i++}`);
      values.push(dto.description?.trim() ? dto.description.trim() : null);
    }
    if (dto.avatar !== undefined) {
      parts.push(`avatar = $${i++}`);
      values.push(dto.avatar?.trim() ? dto.avatar.trim() : null);
    }
    if (!parts.length) {
      throw new BadRequestException('Нет полей для обновления');
    }
    parts.push('updated_at = NOW()');
    values.push(roomId);
    const { rows } = await this.pool.query(
      `UPDATE group_rooms SET ${parts.join(', ')}
       WHERE id = $${i}
       RETURNING
         id,
         name,
         description,
         avatar,
         currency_code AS "currencyCode",
         created_by AS "createdBy",
         created_at AS "createdAt",
         updated_at AS "updatedAt"`,
      values,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Комната не найдена');
    await this.appendActivity(this.pool, roomId, userId, 'room_updated', 'group_room', roomId, {
      name: row.name,
    });
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'room_updated',
      roomId,
      actorId: userId,
      payload: { roomId },
    });
    return row;
  }

  async deleteRoom(roomId: string, userId: string) {
    await this.ensureRole(this.pool, roomId, userId, 'owner');
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'room_deleted',
      roomId,
      actorId: userId,
    });
    const { rowCount } = await this.pool.query('DELETE FROM group_rooms WHERE id = $1', [roomId]);
    if (!rowCount) throw new NotFoundException('Комната не найдена');
    return { success: true };
  }

  async createInvite(roomId: string, userId: string, dto: CreateGroupInviteDto) {
    await this.ensureRole(this.pool, roomId, userId, 'admin');
    const recentInvites = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM group_invite_links
       WHERE room_id = $1
         AND created_by = $2
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [roomId, userId],
    );
    if (Number(recentInvites.rows[0]?.count ?? '0') >= 20) {
      throw new BadRequestException('Превышен лимит создания инвайтов. Попробуйте позже.');
    }

    const token = randomBytes(24).toString('hex');
    const expiresInHours = dto.expiresInHours ?? 72;
    const { rows } = await this.pool.query(
      `INSERT INTO group_invite_links (room_id, created_by, token, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4::int || ' hours')::interval)
       RETURNING id, room_id AS "roomId", created_by AS "createdBy", token, expires_at AS "expiresAt", created_at AS "createdAt"`,
      [roomId, userId, token, expiresInHours],
    );
    await this.appendActivity(this.pool, roomId, userId, 'invite_created', 'group_invite', rows[0].id);
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'invite_created',
      roomId,
      actorId: userId,
      payload: { inviteId: rows[0].id, expiresAt: rows[0].expiresAt },
    });
    return rows[0];
  }

  async acceptInvite(token: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inviteRes = await client.query<{ id: string; room_id: string; created_by: string | null }>(
        `SELECT id, room_id, created_by
         FROM group_invite_links
         WHERE token = $1
           AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1
         FOR UPDATE`,
        [token],
      );
      const invite = inviteRes.rows[0];
      if (!invite) throw new NotFoundException('Инвайт недействителен или просрочен');

      const memberRes = await client.query(
        `SELECT user_id
         FROM group_members
         WHERE room_id = $1 AND user_id = $2
         LIMIT 1`,
        [invite.room_id, userId],
      );

      if (!memberRes.rows[0]) {
        await client.query(
          `INSERT INTO group_members (room_id, user_id, role, invited_by)
           VALUES ($1, $2, 'member', $3)`,
          [invite.room_id, userId, invite.created_by],
        );
        await this.appendActivity(
          client,
          invite.room_id,
          userId,
          'member_joined',
          'group_member',
          userId,
        );
      }

      await client.query('DELETE FROM group_invite_links WHERE id = $1', [invite.id]);
      await client.query('COMMIT');
      await this.groupRoomsEvents.publishToRoom(invite.room_id, {
        type: 'member_joined',
        roomId: invite.room_id,
        actorId: userId,
        payload: { userId },
      });
      return { success: true, roomId: invite.room_id, alreadyMember: Boolean(memberRes.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectInvite(token: string) {
    const { rowCount } = await this.pool.query('DELETE FROM group_invite_links WHERE token = $1', [token]);
    return { success: true, deleted: (rowCount ?? 0) > 0 };
  }

  async updateMemberRole(roomId: string, targetUserId: string, actorId: string, dto: UpdateGroupMemberRoleDto) {
    const actorRole = await this.ensureRole(this.pool, roomId, actorId, 'owner');
    if (actorRole !== 'owner') {
      throw new ForbiddenException('Только владелец комнаты может менять роли');
    }
    if (targetUserId === actorId) {
      throw new BadRequestException('Нельзя менять собственную роль владельца');
    }
    const targetRole = await this.getMemberRole(this.pool, roomId, targetUserId);
    if (!targetRole) throw new NotFoundException('Участник не найден');
    if (targetRole === 'owner') {
      throw new BadRequestException('Нельзя изменить роль владельца');
    }

    const { rows } = await this.pool.query(
      `UPDATE group_members
       SET role = $1
       WHERE room_id = $2 AND user_id = $3
       RETURNING room_id AS "roomId", user_id AS "userId", role, joined_at AS "joinedAt"`,
      [dto.role, roomId, targetUserId],
    );
    await this.appendActivity(this.pool, roomId, actorId, 'member_role_changed', 'group_member', targetUserId, {
      role: dto.role,
    });
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'member_role_changed',
      roomId,
      actorId,
      payload: { targetUserId, role: dto.role },
    });
    return rows[0];
  }

  async removeMember(roomId: string, targetUserId: string, actorId: string) {
    const actorRole = await this.ensureRole(this.pool, roomId, actorId, 'admin');
    const targetRole = await this.getMemberRole(this.pool, roomId, targetUserId);
    if (!targetRole) throw new NotFoundException('Участник не найден');
    if (targetRole === 'owner') throw new BadRequestException('Нельзя удалить владельца комнаты');

    if (actorRole === 'admin' && targetRole === 'admin') {
      throw new ForbiddenException('Администратор не может удалять другого администратора');
    }

    const { rowCount } = await this.pool.query(
      'DELETE FROM group_members WHERE room_id = $1 AND user_id = $2',
      [roomId, targetUserId],
    );
    await this.appendActivity(this.pool, roomId, actorId, 'member_removed', 'group_member', targetUserId);
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'member_removed',
      roomId,
      actorId,
      payload: { targetUserId },
    });
    return { success: (rowCount ?? 0) > 0 };
  }

  async getRoomTransactions(roomId: string, userId: string) {
    await this.ensureRole(this.pool, roomId, userId, 'member');
    const hasCardCol = await this.ensureGroupTxCardIdColumn();
    const hasTypeCol = await this.ensureGroupTxTypeColumn();
    const hasAffectsCol = await this.ensureGroupTxAffectsCardBalanceColumn();
    const cardIdSelect = hasCardCol ? 'gt.card_id AS "cardId"' : 'NULL::integer AS "cardId"';
    const typeSelect = hasTypeCol
      ? `COALESCE(gt.type::text, 'expense') AS "type"`
      : `'expense' AS "type"`;
    const affectsSelect = hasAffectsCol
      ? 'COALESCE(gt.affects_card_balance, TRUE) AS "affectsCardBalance"'
      : 'TRUE AS "affectsCardBalance"';
    const displayName = (alias: string) => `COALESCE(
           NULLIF(
             TRIM(
               CONCAT_WS(
                 ' ',
                 NULLIF(TRIM(COALESCE(${alias}.name, '')), ''),
                 NULLIF(TRIM(COALESCE(${alias}.lastname, '')), '')
               )
             ),
             ''
           ),
           NULLIF(SPLIT_PART(COALESCE(${alias}.email, ''), '@', 1), ''),
           '—'
         )`;

    const { rows } = await this.pool.query(
      `SELECT
         gt.id,
         gt.room_id AS "roomId",
         gt.paid_by AS "paidBy",
         gt.created_by AS "createdBy",
         gt.category_id AS "categoryId",
         ${cardIdSelect},
         ${typeSelect},
         ${affectsSelect},
         gt.amount::float8 AS amount,
         gt.currency_code AS "currencyCode",
         gt.title,
         gt.description,
         gt.date,
         gt.is_split AS "isSplit",
         gt.created_at AS "createdAt",
         gt.updated_at AS "updatedAt",
         ${displayName('creator')} AS "createdByName",
         ${displayName('payer')} AS "paidByName"
       FROM group_transactions gt
       LEFT JOIN users creator ON creator.id = gt.created_by
       LEFT JOIN users payer ON payer.id = gt.paid_by
       WHERE gt.room_id = $1
       ORDER BY gt.date DESC, gt.created_at DESC`,
      [roomId],
    );
    return rows;
  }

  /**
   * Кто сколько «внёс» по комнате: агрегат по плательщику (paid_by, иначе created_by).
   * Суммы по валюте транзакции; фронт конвертирует в основную валюту.
   */
  async getRoomContributions(roomId: string, userId: string) {
    await this.ensureRole(this.pool, roomId, userId, 'member');

    const nameExpr = `COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ', u.name, u.lastname)), ''),
      NULLIF(SPLIT_PART(COALESCE(u.email, ''), '@', 1), ''),
      '—'
    )`;

    const { rows: totalRows } = await this.pool.query<{
      userId: string;
      name: string;
      amount: string;
      currencyCode: string;
    }>(
      `SELECT
         COALESCE(gt.paid_by, gt.created_by)::text AS "userId",
         ${nameExpr} AS "name",
         SUM(gt.amount)::float8::text AS "amount",
         gt.currency_code AS "currencyCode"
       FROM group_transactions gt
       LEFT JOIN users u ON u.id = COALESCE(gt.paid_by, gt.created_by)
       WHERE gt.room_id = $1::uuid
         AND COALESCE(gt.paid_by, gt.created_by) IS NOT NULL
         AND COALESCE(gt.type::text, 'expense') = 'expense'
       GROUP BY COALESCE(gt.paid_by, gt.created_by), u.name, u.lastname, u.email, gt.currency_code
       ORDER BY SUM(gt.amount) DESC`,
      [roomId],
    );

    const { rows: catRows } = await this.pool.query<{
      categoryId: string | null;
      categoryName: string;
      userId: string;
      name: string;
      amount: string;
      currencyCode: string;
    }>(
      `SELECT
         gt.category_id::text AS "categoryId",
         COALESCE(c.name, 'Uncategorized') AS "categoryName",
         COALESCE(gt.paid_by, gt.created_by)::text AS "userId",
         ${nameExpr} AS "name",
         SUM(gt.amount)::float8::text AS "amount",
         gt.currency_code AS "currencyCode"
       FROM group_transactions gt
       LEFT JOIN categories c ON c.id = gt.category_id
       LEFT JOIN users u ON u.id = COALESCE(gt.paid_by, gt.created_by)
       WHERE gt.room_id = $1::uuid
         AND COALESCE(gt.paid_by, gt.created_by) IS NOT NULL
         AND COALESCE(gt.type::text, 'expense') = 'expense'
       GROUP BY gt.category_id, c.name, COALESCE(gt.paid_by, gt.created_by), u.name, u.lastname, u.email, gt.currency_code
       ORDER BY "categoryName", SUM(gt.amount) DESC`,
      [roomId],
    );

    const byCategoryMap = new Map<
      string,
      { categoryId: string | null; categoryName: string; members: RoomContributionMemberDto[] }
    >();

    for (const r of catRows) {
      const key = r.categoryId ?? '__none__';
      if (!byCategoryMap.has(key)) {
        byCategoryMap.set(key, {
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          members: [],
        });
      }
      byCategoryMap.get(key)!.members.push({
        userId: r.userId,
        name: r.name,
        amount: parseFloat(r.amount),
        currencyCode: r.currencyCode,
      });
    }

    const totalsByMember: RoomContributionMemberDto[] = totalRows.map((r) => ({
      userId: r.userId,
      name: r.name,
      amount: parseFloat(r.amount),
      currencyCode: r.currencyCode,
    }));

    return {
      totalsByMember,
      byCategory: Array.from(byCategoryMap.values()),
    };
  }

  async createRoomTransaction(roomId: string, userId: string, dto: CreateGroupTransactionDto) {
    await this.ensureRole(this.pool, roomId, userId, 'member');
    const hasCardCol = await this.ensureGroupTxCardIdColumn();
    const hasTypeCol = await this.ensureGroupTxTypeColumn();
    const hasAffectsCol = await this.ensureGroupTxAffectsCardBalanceColumn();
    const txType: 'expense' | 'revenue' = dto.type === 'revenue' ? 'revenue' : 'expense';
    const affectBalance = dto.affectsCardBalance !== false;
    const paidBy = dto.paidBy ?? userId;
    const paidByRole = await this.getMemberRole(this.pool, roomId, paidBy);
    if (!paidByRole) {
      throw new BadRequestException('paidBy должен быть участником комнаты');
    }
    let cardId =
      dto.cardId != null && Number.isFinite(Number(dto.cardId)) ? Math.trunc(Number(dto.cardId)) : null;
    if (!hasCardCol) {
      cardId = null;
    }
    if (cardId != null) {
      await this.transactionsService.assertPersonalCardBelongsToUser(cardId, paidBy);
    }

    const cur = dto.currencyCode ?? 'BYN';
    const cols: string[] = ['room_id', 'paid_by', 'created_by', 'category_id'];
    const vals: unknown[] = [roomId, paidBy, userId, dto.categoryId ?? null];
    if (hasCardCol) {
      cols.push('card_id');
      vals.push(cardId);
    }
    cols.push('amount', 'currency_code', 'title', 'description', 'date');
    vals.push(dto.amount, cur, dto.title, dto.description ?? null, dto.date);
    if (hasTypeCol) {
      cols.push('type');
      vals.push(txType);
    }
    if (hasAffectsCol) {
      cols.push('affects_card_balance');
      vals.push(affectBalance);
    }

    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const cardIdReturning = hasCardCol
      ? 'card_id AS "cardId",'
      : 'NULL::integer AS "cardId",';
    const typeReturning = hasTypeCol ? 'type,' : '';
    const affectsReturning = hasAffectsCol
      ? 'affects_card_balance AS "affectsCardBalance",'
      : 'TRUE AS "affectsCardBalance",';
    const returningSql = `
       RETURNING
         id,
         room_id AS "roomId",
         paid_by AS "paidBy",
         created_by AS "createdBy",
         category_id AS "categoryId",
         ${cardIdReturning}
         amount::float8 AS amount,
         currency_code AS "currencyCode",
         title,
         description,
         date,
         is_split AS "isSplit",
         ${typeReturning}
         ${affectsReturning}
         created_at AS "createdAt",
         updated_at AS "updatedAt"`;

    const { rows } = await this.pool.query(
      `INSERT INTO group_transactions (${cols.join(', ')}, is_split)
       VALUES (${placeholders}, false)
       ${returningSql}`,
      vals,
    );

    const created = rows[0] as { id: string };
    const shouldApplyCard = cardId != null && (hasAffectsCol ? affectBalance : true);
    if (shouldApplyCard && cardId != null) {
      try {
        await this.transactionsService.applyPersonalCardForGroupTx(
          paidBy,
          cardId,
          dto.amount,
          cur,
          hasTypeCol ? txType : 'expense',
        );
      } catch (err) {
        await this.pool.query('DELETE FROM group_transactions WHERE id = $1', [created.id]);
        throw err;
      }
    }
    await this.appendActivity(
      this.pool,
      roomId,
      userId,
      'group_transaction_created',
      'group_transaction',
      created.id,
    );
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'group_transaction_created',
      roomId,
      actorId: userId,
      payload: { transactionId: created.id },
    });
    return created;
  }

  async updateRoomTransaction(
    roomId: string,
    transactionId: string,
    userId: string,
    dto: UpdateGroupTransactionDto,
  ) {
    const hasCardCol = await this.ensureGroupTxCardIdColumn();
    const hasTypeCol = await this.ensureGroupTxTypeColumn();
    const hasAffectsCol = await this.ensureGroupTxAffectsCardBalanceColumn();
    const role = await this.ensureRole(this.pool, roomId, userId, 'member');
    const existingRes = await this.pool.query<{ created_by: string | null }>(
      `SELECT created_by
       FROM group_transactions
       WHERE id = $1 AND room_id = $2
       LIMIT 1`,
      [transactionId, roomId],
    );
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundException('Групповая транзакция не найдена');
    if (role === 'member' && existing.created_by !== userId) {
      throw new ForbiddenException('Можно редактировать только свои транзакции');
    }
    if (dto.paidBy) {
      const paidByRole = await this.getMemberRole(this.pool, roomId, dto.paidBy);
      if (!paidByRole) throw new BadRequestException('paidBy должен быть участником комнаты');
    }
    const cardRet = hasCardCol ? 'card_id AS "cardId"' : 'NULL::integer AS "cardId"';
    const typeRet = hasTypeCol ? 'type,' : '';
    const affectsRet = hasAffectsCol ? 'affects_card_balance AS "affectsCardBalance",' : 'TRUE AS "affectsCardBalance",';
    const { rows } = await this.pool.query(
      `UPDATE group_transactions
       SET paid_by = COALESCE($1, paid_by),
           category_id = COALESCE($2, category_id),
           amount = COALESCE($3, amount),
           currency_code = COALESCE($4, currency_code),
           title = COALESCE($5, title),
           description = COALESCE($6, description),
           date = COALESCE($7, date),
           updated_at = NOW()
       WHERE id = $8 AND room_id = $9
       RETURNING
         id,
         room_id AS "roomId",
         paid_by AS "paidBy",
         created_by AS "createdBy",
         category_id AS "categoryId",
         ${cardRet},
         amount::float8 AS amount,
         currency_code AS "currencyCode",
         title,
         description,
         date,
         is_split AS "isSplit",
         ${typeRet}
         ${affectsRet}
         created_at AS "createdAt",
         updated_at AS "updatedAt"`,
      [
        dto.paidBy ?? null,
        dto.categoryId ?? null,
        dto.amount ?? null,
        dto.currencyCode ?? null,
        dto.title ?? null,
        dto.description ?? null,
        dto.date ?? null,
        transactionId,
        roomId,
      ],
    );
    await this.appendActivity(
      this.pool,
      roomId,
      userId,
      'group_transaction_updated',
      'group_transaction',
      transactionId,
    );
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'group_transaction_updated',
      roomId,
      actorId: userId,
      payload: { transactionId },
    });
    return rows[0];
  }

  async deleteRoomTransaction(roomId: string, transactionId: string, userId: string) {
    const hasCardCol = await this.ensureGroupTxCardIdColumn();
    const hasTypeCol = await this.ensureGroupTxTypeColumn();
    const hasAffectsCol = await this.ensureGroupTxAffectsCardBalanceColumn();
    const role = await this.ensureRole(this.pool, roomId, userId, 'member');
    const cardSel = hasCardCol ? 'card_id' : 'NULL::integer AS card_id';
    const typeSel = hasTypeCol ? `COALESCE(type::text, 'expense') AS type` : `'expense' AS type`;
    const affectsSel = hasAffectsCol
      ? 'COALESCE(affects_card_balance, TRUE) AS affects_card_balance'
      : 'TRUE AS affects_card_balance';
    const existingRes = await this.pool.query<{
      created_by: string | null;
      paid_by: string | null;
      card_id: number | null;
      amount: string;
      currency_code: string;
      type: string;
      affects_card_balance: boolean;
    }>(
      `SELECT created_by, paid_by, ${cardSel}, amount, currency_code, ${typeSel}, ${affectsSel}
       FROM group_transactions
       WHERE id = $1 AND room_id = $2
       LIMIT 1`,
      [transactionId, roomId],
    );
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundException('Групповая транзакция не найдена');
    if (role === 'member' && existing.created_by !== userId) {
      throw new ForbiddenException('Можно удалять только свои транзакции');
    }
    if (
      existing.affects_card_balance &&
      existing.card_id != null &&
      existing.paid_by
    ) {
      const txType: 'expense' | 'revenue' =
        existing.type === 'revenue' ? 'revenue' : 'expense';
      await this.transactionsService.reversePersonalCardForGroupTx(
        existing.paid_by,
        Number(existing.card_id),
        parseFloat(String(existing.amount)),
        existing.currency_code ?? 'BYN',
        txType,
      );
    }
    const { rowCount } = await this.pool.query(
      'DELETE FROM group_transactions WHERE id = $1 AND room_id = $2',
      [transactionId, roomId],
    );
    await this.appendActivity(
      this.pool,
      roomId,
      userId,
      'group_transaction_deleted',
      'group_transaction',
      transactionId,
    );
    await this.groupRoomsEvents.publishToRoom(roomId, {
      type: 'group_transaction_deleted',
      roomId,
      actorId: userId,
      payload: { transactionId },
    });
    return { success: (rowCount ?? 0) > 0 };
  }
}
