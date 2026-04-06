import { GroupRoomsEventsService } from './group-rooms-events.service';

describe('GroupRoomsEventsService', () => {
  const poolMock = {
    query: jest.fn(),
  } as any;

  let service: GroupRoomsEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GroupRoomsEventsService(poolMock);
  });

  it('publishes event to active user stream', (done) => {
    const stream$ = service.streamForUser('user-1');
    const sub = stream$.subscribe((event) => {
      if (event.type !== 'room_created') return;
      expect((event.data as any).roomId).toBe('room-1');
      sub.unsubscribe();
      done();
    });

    service.publishToUser('user-1', {
      type: 'room_created',
      roomId: 'room-1',
      actorId: 'user-1',
    });
  });

  it('publishes room events to each member', async () => {
    poolMock.query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }],
    });

    const user1 = jest.fn();
    const user2 = jest.fn();
    const sub1 = service
      .streamForUser('u1')
      .subscribe((event) => event.type === 'invite_created' && user1(event));
    const sub2 = service
      .streamForUser('u2')
      .subscribe((event) => event.type === 'invite_created' && user2(event));

    await service.publishToRoom('room-1', {
      type: 'invite_created',
      roomId: 'room-1',
    });

    expect(poolMock.query).toHaveBeenCalled();
    expect(user1).toHaveBeenCalled();
    expect(user2).toHaveBeenCalled();
    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('tracks active SSE connections', () => {
    service.streamForUser('u1');
    service.streamForUser('u2');
    expect(service.activeConnectionsCount()).toBe(2);
    service.closeUserStream('u2');
    expect(service.activeConnectionsCount()).toBe(1);
  });
});
