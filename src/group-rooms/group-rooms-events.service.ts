import { Inject, Injectable, Logger, MessageEvent } from '@nestjs/common';
import { Pool } from 'pg';
import { Observable, Subject, interval, map, merge } from 'rxjs';
import { PG_POOL } from '../pg/pg.module';

type GroupEventPayload = {
  type: string;
  roomId?: string;
  actorId?: string;
  payload?: Record<string, unknown>;
};

@Injectable()
export class GroupRoomsEventsService {
  private readonly streams = new Map<string, Subject<MessageEvent>>();
  private readonly logger = new Logger(GroupRoomsEventsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  streamForUser(userId: string): Observable<MessageEvent> {
    let stream = this.streams.get(userId);
    if (!stream) {
      stream = new Subject<MessageEvent>();
      this.streams.set(userId, stream);
      this.logger.debug(`SSE connected: user=${userId}, active=${this.streams.size}`);
    }

    const heartbeat$ = interval(20000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { ts: Date.now() },
      })),
    );

    return merge(stream.asObservable(), heartbeat$);
  }

  async publishToUser(userId: string, payload: GroupEventPayload): Promise<void> {
    const stream = this.streams.get(userId);
    if (!stream) return;
    stream.next({
      type: payload.type,
      data: {
        ...payload,
        ts: Date.now(),
      },
    });
  }

  async publishToRoom(roomId: string, payload: GroupEventPayload): Promise<void> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      'SELECT user_id FROM group_members WHERE room_id = $1',
      [roomId],
    );
    await Promise.all(rows.map((row) => this.publishToUser(row.user_id, payload)));
  }

  closeUserStream(userId: string): void {
    const stream = this.streams.get(userId);
    if (!stream) return;
    stream.complete();
    this.streams.delete(userId);
    this.logger.debug(`SSE disconnected: user=${userId}, active=${this.streams.size}`);
  }

  activeConnectionsCount(): number {
    return this.streams.size;
  }
}
